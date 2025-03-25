import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import path from 'path';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH;

// Dynamic import with assertion
// const serviceAccount = JSON.parse(
//     fs.readFileSync(path.join(__dirname, 'serviceAccountKey.json'), 'utf8')
// );

// Initialize the Firebase Admin SDK with your credentials.
admin.initializeApp(
  // {credential: admin.credential.cert(serviceAccount)}
);

// Get a Firestore instance.
const db = admin.firestore();

const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Add service status tracking
let serviceStatus = {
  server: 'healthy',
  twilio: 'unknown',
  lastChecked: new Date().toISOString()
};

// Function to check Twilio service status
async function checkTwilioStatus() {
  try {
    await client.api.accounts(accountSid).fetch();
    serviceStatus.twilio = 'healthy';
  } catch (error) {
    serviceStatus.twilio = 'error';
    console.error('Twilio service error:', error);
  }
  serviceStatus.lastChecked = new Date().toISOString();
}

// Initial Twilio status check
checkTwilioStatus();

// Periodic Twilio status check every 60 seconds
setInterval(checkTwilioStatus, 60000);

// Function to log messages to a file and Firestore
async function logToFile(phone, message) {
  const logMessage = `${new Date().toISOString()} - ${phone} - ${message}\n`;
  // Log to Firestore
  try {
    await db.collection('logs').add({
      phone,
      message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error writing to Firestore log:', error);
  }
}

async function bulkCall(phoneNumbers, hotlineId) {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1,
    action: `${process.env.HOST_IP}/processResponse`,
    method: 'POST'
  });
  gather.say(
    'Attention: Code Blue. This is an emergency alert from BITS Goa Medical Center. If you are available to respond immediately, please press 1; if not, press 2.',
    { voice: 'alice' }
  );
  twiml.redirect(`${process.env.HOST_IP}/notanswered`);

  // Create all calls concurrently and collect phone-to-SID mappings.
  const callResults = await Promise.all(phoneNumbers.map(async (phone) => {
    try {
      let call = await client.calls.create({
        from: "+18313221097",
        to: phone,
        twiml: twiml.toString(),
        statusCallback: `${process.env.HOST_IP}/callStatus?hotlineId=${hotlineId}`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: 'POST'
      });
      logToFile(phone, `Call attempt created. SID: ${call.sid}`);
      return { phone, sid: call.sid };
    } catch (error) {
      logToFile(phone, 'Error creating call: ' + error.message);
      throw new Error('Error creating call: ' + error.message);
    }
  }));

  // Read the document once.
  const hotlineRef = db.collection('codeblue_history').doc(hotlineId);
  const hotlineDoc = await hotlineRef.get();
  const hotlineData = hotlineDoc.data();

  // Update the callStatus array with the new SIDs.
  const updatedCallStatus = hotlineData.callStatus.map(entry => {
    // Find the call result for this phone.
    const result = callResults.find(res => res.phone === entry.phone);
    return result ? { ...entry, sid: result.sid } : entry;
  });

  // Perform a single batch update.
  const batch = db.batch();
  batch.update(hotlineRef, { callStatus: updatedCallStatus });
  await batch.commit();
}

// Endpoint to handle call status callbacks
app.post('/callStatus', async (req, res) => {
  console.log('Call status received:', req.body.CallStatus);
  if(req.body.CallStatus === 'busy' || req.body.CallStatus === 'no-answer' || req.body.CallStatus === 'failed' || req.body.CallStatus === 'canceled') {
    const sid = req.body.CallSid;
    const hotlineRef = db.collection('codeblue_history').orderBy('dateTime', 'desc').limit(1);
    const hotlineSnapshot = await hotlineRef.get();
    const hotlineDoc = hotlineSnapshot.docs[0];
    const hotlineId = hotlineDoc.id;
    const hotlineData = hotlineDoc.data();
    const call = hotlineData.callStatus.find(entry => entry.sid === sid);
    if (call) {
      await updateCallStatus(sid, hotlineId, `Not Responded ${call.tryNumber}st Call`,call.tryNumber+1);
    }else{
      console.log('Call not found');
    }
  }
  // Always respond with a 200 OK so Twilio knows the callback was processed
  res.sendStatus(200);
});
// Helper sleep function that returns a Promise which resolves after a given time in ms.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runHotlineProcess(hotlineId) {
  // Define hotlineRef using the provided hotlineId
  const hotlineRef = db.collection('codeblue_history').doc(hotlineId);

  // Wait for 120 seconds
  await sleep(120000);

  // Check the list of active numbers
  let hotlineDoc = await hotlineRef.get();
  let hotlineData = hotlineDoc.data();
  let activeNumbers = hotlineData.callStatus
    .filter(entry => entry.status !== 'Accepted' && entry.status !== 'Declined')
    .map(entry => entry.phone);

  if (activeNumbers.length > 0) {
    // Perform a batch update
    await bulkCall(activeNumbers, hotlineId);

    // Wait for another 3 minutes
    await sleep(240000);

    // Check active numbers again
    hotlineDoc = await hotlineRef.get();
    hotlineData = hotlineDoc.data();
    activeNumbers = hotlineData.callStatus
      .filter(entry => entry.status !== 'Accepted' && entry.status !== 'Declined')
      .map(entry => entry.phone);

    if (activeNumbers.length > 0) {
      await bulkCall(activeNumbers, hotlineId);

      // Wait for 1 minute before sending WhatsApp messages
      await sleep(90000);

      // Check active numbers again
      hotlineDoc = await hotlineRef.get();
      hotlineData = hotlineDoc.data();
      activeNumbers = hotlineData.callStatus
        .filter(entry => entry.status !== 'Accepted' && entry.status !== 'Declined')
        .map(entry => entry.phone);

      // Send WhatsApp messages sequentially to all active numbers
      for (const phone of activeNumbers) {
        try {
          await client.messages.create({
            from: 'whatsapp:+18313221097', // Your Twilio WhatsApp number
            to: `whatsapp:${phone}`,       // The recipient’s WhatsApp number
            contentSid: 'HXfb1f06b0d16236b6d06ae5b18956ba7b' // The approved message template SID
          });
        } catch (error) {
          console.error('Error sending WhatsApp message:', error);
        }
      }

      // Wait for another minute before sending a report
      await sleep(60000);

    }
  }
  try {
  hotlineDoc = await hotlineRef.get();
  hotlineData = hotlineDoc.data();
  const callStatus = hotlineData.callStatus;

  const membersSnapshot = await db.collection('members').get();
  const members = membersSnapshot.docs.map(doc => doc.data());

  const report = callStatus.map(entry => {
    const member = members.find(member => member.phone === entry.phone);
    const name = member ? member.name : 'Unknown';
    return `Name: ${name}, Status: ${entry.status}`;
  }).join('\n');
  await client.messages.create({
    from: 'whatsapp:+18313221097', // Your Twilio WhatsApp number
    to: 'whatsapp:+919979449268',   // The recipient’s WhatsApp number
    body: `Call Status Report:\n${report}`
  });
  console.log('Call status report sent successfully.');
} catch (error) {
  console.error('Error sending call status report:', error);
}

}

app.post('/hotline', async (req, res) => {
  // Create a new entry in codeblue_history with the current date-time and an empty callStatus array
  const hotlineRef = db.collection('codeblue_history').doc();
  await hotlineRef.set({
  dateTime: new Date().toISOString(),
  callStatus: []
  });
  const hotlineId = hotlineRef.id;
  try {
    const membersSnapshot = await db.collection('members').get();
    const members = membersSnapshot.docs.map(doc => doc.data());
    // Initialize callStatus for all members
    const callStatus = members.map(member => ({
      phone: member.phone,
      status: 'Initiated',
      tryNumber: 1
    }));
    await hotlineRef.update({ callStatus });
    // Create an array of phone numbers
    const phoneNumbers = members.map(member => member.phone);
    // Perform the bulk call
    await bulkCall(phoneNumbers, hotlineId);
    runHotlineProcess(hotlineId);
    res.status(200).send('Hotline started successfully');
  }
  catch (error) {
    console.error('Error starting hotline:', error);
    res.status(500).send('Error starting hotline');
  }
});

app.post('/whatsappYes', async (req, res) => {
  const senderNumber = req.body.sender_number.replace('whatsapp:', '');
  if (!senderNumber) {
      console.error('Sender number is missing in the request body.');
      return res.status(400).send('Bad Request: sender_number is required.');
  }
  const hotlineRef = db.collection('codeblue_history').orderBy('dateTime', 'desc').limit(1);
  const hotlineSnapshot = await hotlineRef.get();
  const hotlineDoc = hotlineSnapshot.docs[0];
  const hotlineId = hotlineDoc.id;
  const hotlineData = hotlineDoc.data();
  const callStatus = hotlineData.callStatus.find(entry => entry.phone === senderNumber);
  const sid = callStatus ? callStatus.sid : null;
  if (!sid) {
    console.error('SID not found for the given sender number.');
    return res.status(404).send('SID not found for the given sender number.');
  }
  await updateCallStatus(sid, hotlineId, 'Accepted');
  res.status(200).send('Accepted');
});

app.post('/whatsappNo', async (req, res) => {
  const senderNumber = req.body.sender_number.replace('whatsapp:', '');
  if (!senderNumber) {
      console.error('Sender number is missing in the request body.');
      return res.status(400).send('Bad Request: sender_number is required.');
  }
  const hotlineRef = db.collection('codeblue_history').orderBy('dateTime', 'desc').limit(1);
  const hotlineSnapshot = await hotlineRef.get();
  const hotlineDoc = hotlineSnapshot.docs[0];
  const hotlineId = hotlineDoc.id;
  const hotlineData = hotlineDoc.data();
  const callStatus = hotlineData.callStatus.find(entry => entry.phone === senderNumber);
  const sid = callStatus ? callStatus.sid : null;
  if (!sid) {
    console.error('SID not found for the given sender number.');
    return res.status(404).send('SID not found for the given sender number.');
  }
  await updateCallStatus(sid, hotlineId, 'Declined');
  res.status(200).send('Declined');
});

app.post('/processResponse', async (req, res) => {
  const digit = req.body.Digits;
  const response = new VoiceResponse();
  const sid = req.body.CallSid;
  console.log('Received input:', digit);
  const hotlineRef = db.collection('codeblue_history').orderBy('dateTime', 'desc').limit(1);
  const hotlineSnapshot = await hotlineRef.get();
  const hotlineDoc = hotlineSnapshot.docs[0];
  const hotlineId = hotlineDoc.id;
  const hotlineData = hotlineDoc.data();
  const call = hotlineData.callStatus.find(entry => entry.sid === sid);
  const sender = call ? call.phone : 'unknown';
  logToFile(sender, 'Received input: ' + digit);
  if (digit === '1') {
  console.log('Emergency call accepted.');
  logToFile(sender, 'Emergency call accepted.');
  response.say('Emergency call accepted. Goodbye.');
  await updateCallStatus(sid, hotlineId, 'Accepted');
  } else if (digit === '2') {
  console.log('Emergency call declined.');
  logToFile(sender, 'Emergency call declined.');
  response.say('Emergency call declined. Goodbye.');
  await updateCallStatus(sid, hotlineId, 'Declined');
  } else {
  console.log('Invalid input.');
  logToFile(sender, 'Invalid input.');
  response.say('Invalid input. Goodbye.');
  await updateCallStatus(sid, hotlineId, 'Invalid');
  }
  response.hangup();
  res.type('text/xml');
  res.send(response.toString());
});

app.post('/notanswered', async (req, res) => {
  console.log('No response received.');
  const sid = req.body.CallSid;
  const hotlineRef = db.collection('codeblue_history').orderBy('dateTime', 'desc').limit(1);
  const hotlineSnapshot = await hotlineRef.get();
  const hotlineDoc = hotlineSnapshot.docs[0];
  const hotlineId = hotlineDoc.id;
  const hotlineData = hotlineDoc.data();
  const call = hotlineData.callStatus.find(entry => entry.sid === sid);
  const sender = call ? call.phone : 'unknown';
  logToFile(sender, 'No response received for SID: ' + sid);
  if (call) {
  await updateCallStatus(sid, hotlineId, `Not Responded ${call.tryNumber}st Call`,call.tryNumber+1);
  }
  console.log('No response received.');
  res.send('No response received.');
});

async function updateCallStatus(sid, hotlineId, status, tryNumber = 1) {
  const hotlineRef = db.collection('codeblue_history').doc(hotlineId);
  
  try {
    await db.runTransaction(async (transaction) => {
      const hotlineDoc = await transaction.get(hotlineRef);
      if (!hotlineDoc.exists) {
        throw new Error("Hotline document does not exist!");
      }
      const hotlineData = hotlineDoc.data();

      // Update the callStatus array atomically
      const updatedCallStatus = hotlineData.callStatus.map(entry => {
        return entry.sid === sid ? { ...entry, status, tryNumber } : entry;
      });

      // Atomically update the document within the transaction
      transaction.update(hotlineRef, { callStatus: updatedCallStatus });
    });
    console.log("Transaction successfully committed.");
  } catch (error) {
    console.error("Transaction failed: ", error);
  }
}


app.get('/callReport', async (_, res) => {
  try {
  const hotlineRef = db.collection('codeblue_history').orderBy('dateTime', 'desc').limit(1);
  const hotlineSnapshot = await hotlineRef.get();
  const hotlineDoc = hotlineSnapshot.docs[0];
  const callStatus = hotlineDoc.data().callStatus;
  try {
    const membersSnapshot = await db.collection('members').get();
    const members = membersSnapshot.docs.map(doc => doc.data());

    const report = callStatus.map(call => {
    const member = members.find(member => member.phone === call.phone);
    return {
      ...call,
      name: member ? member.name : 'Unknown'
    };
    });
    res.status(200).send(report);
  } catch (error) {
    res.status(500).send({ message: 'Error reading members from Firestore', error });
  }
  } catch (error) {
  res.status(500).send({ message: 'Error reading call status from Firestore', error });
  }
});

app.post('/removeMember', async (req, res) => {
  console.log('Request received:', req.body);
  const { phone } = req.body;

  try {
    const membersRef = db.collection('members');
    const snapshot = await membersRef.where('phone', '==', phone).get();
    if (snapshot.empty) {
      return res.status(404).send({ message: 'Member not found' });
    }

    snapshot.forEach(doc => {
      doc.ref.delete();
    });

    res.status(200).send({ message: 'Member removed successfully' });
  } catch (error) {
    res.status(500).send({ message: 'Error removing member from Firestore', error });
  }
});

app.post('/addMember', async (req, res) => {
  console.log('Request received:', req.body);
  const { name, phone } = req.body;
  const newMember = { name, phone };

  try {
    await db.collection('members').add(newMember);
    res.status(200).send({ message: 'Member added successfully' });
  } catch (error) {
    res.status(500).send({ message: 'Error adding member to Firestore', error });
  }
});

app.get('/allmembers', async (req, res) => {
  try {
    const membersSnapshot = await db.collection('members').get();
    const members = membersSnapshot.docs.map(doc => doc.data());
    res.status(200).json(members);
  } catch (error) {
    res.status(500).send({ message: 'Error retrieving members from Firestore', error });
  }
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Service status endpoint
app.get('/service-status', (req, res) => {
  res.status(200).json(serviceStatus);
});

app.listen(3001, () => {
  console.log('Server is running on port 3001');
});
