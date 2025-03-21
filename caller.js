import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import path from 'path';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

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
const serviceAccount = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'serviceAccountKey.json'), 'utf8')
);

// Initialize the Firebase Admin SDK with your credentials.
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

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

let callStatus = [];

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

// Function to create a call
async function createCall(sender) {
  logToFile(sender, 'Request received: ' + sender);
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

  twiml.redirect(
    `${process.env.HOST_IP}/notanswered`
  );

  try {
    const call = await client.calls.create({
      from: "+18313221097",
      to: sender,
      twiml: twiml.toString(),
    });

    callStatus.push({ phone: sender, status: 'In Progress', sid: call.sid });
    logToFile(sender, `Call created successfully. SID: ${call.sid}`);
    return { message: 'Call has been created successfully.', sid: call.sid };
  } catch (error) {
    logToFile(sender, 'Error creating call: ' + error.message);
    throw new Error('Error creating call: ' + error.message);
  }
}

app.post('/hotline', async (req, res) => {
  // Clear callStatus array
  callStatus = [];
  // Clear call_status.json and shift data to hotline_history.json
  try {
    const callStatusSnapshot = await db.collection('call_status').get();
    const callStatusData = callStatusSnapshot.docs.map(doc => doc.data());

    const hotlineHistorySnapshot = await db.collection('hotline_history').get();
    const hotlineHistoryData = hotlineHistorySnapshot.docs.map(doc => doc.data());

    const updatedHistory = hotlineHistoryData.concat(callStatusData);

    // Clear call_status collection
    const batch = db.batch();
    callStatusSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Add updated history to hotline_history collection
    const historyBatch = db.batch();
    updatedHistory.forEach(entry => {
      const docRef = db.collection('hotline_history').doc();
      historyBatch.set(docRef, entry);
    });
    await historyBatch.commit();
  } catch (error) {
    console.error('Error updating hotline history:', error);
  }

  try {
    const membersSnapshot = await db.collection('members').get();
    const members = membersSnapshot.docs.map(doc => doc.data());

    for (const member of members) {
      try {
        await createCall(member.phone);
      } catch (error) {
        console.error('Error creating call:', error);
      }
    }

    res.status(200).send("Hotline calls initiated.");
  } catch (error) {
    res.status(500).send({ message: 'Error reading members from Firestore', error });
  }
});

app.post('/processResponse', (req, res) => {
  const digit = req.body.Digits;
  const response = new VoiceResponse();
  const sid = req.body.CallSid;
  console.log('Received input:', digit);
  const call = callStatus.find(call => call.sid === sid);
  const sender = call ? call.phone : 'unknown';
  logToFile(sender, 'Received input: ' + digit);
  if (digit === '1') {
    console.log('Emergency call accepted.');
    logToFile(sender, 'Emergency call accepted.');
    response.say('Emergency call accepted. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Accepted';
    }
  } else if (digit === '2') {
    console.log('Emergency call declined.');
    logToFile(sender, 'Emergency call declined.');
    response.say('Emergency call declined. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Declined';
    }
  } else {
    console.log('Invalid input.');
    logToFile(sender, 'Invalid input.');
    response.say('Invalid input. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Invalid';
    }
  }
  response.hangup();
  res.type('text/xml');
  res.send(response.toString());
});

app.post('/notanswered', (req, res) => {
  const sid = req.body.CallSid;
  console.log('SID:', sid);
  const call = callStatus.find(call => call.sid === sid);
  const sender = call ? call.phone : 'unknown';
  logToFile(sender, 'No response received for SID: ' + sid);
  if (call) {
    call.status = 'No Response';
  }
  console.log('No response received.');
  res.send('No response received.');
});

// Function to update call status in Firestore
async function updateCallStatusFile() {
  try {
    // Clear existing call_status collection
    const callStatusSnapshot = await db.collection('call_status').get();
    const batchDelete = db.batch();
    callStatusSnapshot.docs.forEach(doc => batchDelete.delete(doc.ref));
    await batchDelete.commit();

    // Add new call status entries
    const batchSet = db.batch();
    callStatus.forEach(call => {
      const docRef = db.collection('call_status').doc(call.sid);
      batchSet.set(docRef, call);
    });
    await batchSet.commit();
  } catch (error) {
    console.error('Error updating call status in Firestore:', error);
  }
}

app.get('/callReport', async (_, res) => {
  updateCallStatusFile();
  try {
    const callStatusSnapshot = await db.collection('call_status').get();
    const callStatus = callStatusSnapshot.docs.map(doc => doc.data());
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
