const express = require('express');
const bodyParser = require('body-parser');
const twilio = require("twilio");
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH;


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

const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Initial Twilio status check
checkTwilioStatus();

// Periodic Twilio status check every 60 seconds
setInterval(checkTwilioStatus, 60000);

let callStatus = [];

// Function to log messages to a file
function logToFile(phone,message) {
  const logMessage = `${new Date().toISOString()} - ${phone} - ${message}\n`;
  fs.appendFile(path.join(__dirname, 'call_logs.txt'), logMessage, (err) => {
    if (err) {
      console.error('Error writing to log file:', err);
    }
  });
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
  fs.readFile(path.join(__dirname, 'call_status.json'), 'utf8', (err, callData) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Error reading call status file:', err);
    } else {
      const callStatusData = callData ? JSON.parse(callData) : [];
      fs.readFile(path.join(__dirname, 'hotline_history.json'), 'utf8', (err, historyData) => {
        if (err && err.code !== 'ENOENT') {
          console.error('Error reading hotline history file:', err);
        } else {
          const hotlineHistory = historyData ? JSON.parse(historyData) : [];
          const updatedHistory = hotlineHistory.concat(callStatusData);
          fs.writeFile(path.join(__dirname, 'hotline_history.json'), JSON.stringify(updatedHistory, null, 2), (err) => {
            if (err) {
              console.error('Error writing to hotline history file:', err);
            }
          });
        }
      });
    }

    fs.writeFile(path.join(__dirname, 'call_status.json'), JSON.stringify([], null, 2), (err) => {
      if (err) {
        console.error('Error clearing call status file:', err);
      }
    });
  });
  fs.readFile(path.join(__dirname, 'public', 'members.json'), 'utf8', async (err, data) => {
    if (err) {
      return res.status(500).send({ message: 'Error reading members file', error: err });
    }
    const members = JSON.parse(data);
    for (const member of members) {
      try {
        await createCall(member.phone);
      } catch (error) {
        console.error('Error creating call:', error);
      }
    }

    res.status(200).send("Hotline calls initiated.");
  });
});

app.post('/processResponse', (req, res) => {
  const digit = req.body.Digits;
  const response = new VoiceResponse();
  const sid = req.body.CallSid;
  console.log('Received input:', digit);
  const call = callStatus.find(call => call.sid === sid);
  const sender = call ? call.phone : 'unknown';
  logToFile(sender,'Received input: ' + digit);
  if (digit === '1') {
    console.log('Emergency call accepted.');
    logToFile(sender,'Emergency call accepted.');
    response.say('Emergency call accepted. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Accepted';
    }
  } else if (digit === '2') {
    console.log('Emergency call declined.');
    logToFile(sender,'Emergency call declined.');
    response.say('Emergency call declined. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Declined';
    }
  } else {
    console.log('Invalid input.');
    logToFile(sender,'Invalid input.');
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
  logToFile(sender,'No response received for SID: ' + sid);
  if (call) {
    call.status = 'No Response';
  }
  console.log('No response received.');
  res.send('No response received.');
});

// Function to update call status file
function updateCallStatusFile() {
  fs.writeFile(path.join(__dirname, 'call_status.json'), JSON.stringify(callStatus, null, 2), (err) => {
    if (err) {
      console.error('Error writing to call status file:', err);
    }
  });
}

app.get('/callReport', (_, res) => {
  updateCallStatusFile();
  fs.readFile(path.join(__dirname, 'call_status.json'), 'utf8', (err, callData) => {
    if (err) {
      return res.status(500).send({ message: 'Error reading call status file', error: err });
    }
    let callStatus = [];
    if (callData) {
      try {
        callStatus = JSON.parse(callData);
      } catch (parseError) {
        console.error('Error parsing call status file:', parseError);
      }
    }

    fs.readFile(path.join(__dirname, 'public', 'members.json'), 'utf8', (err, memberData) => {
      if (err) {
        return res.status(500).send({ message: 'Error reading members file', error: err });
      }

      const members = JSON.parse(memberData);

      const report = callStatus.map(call => {
        const member = members.find(member => member.phone === call.phone);
        return {
          ...call,
          name: member ? member.name : 'Unknown'
        };
      });
      res.status(200).send(report);
    });
  });
});

app.post('/removeMember', (req, res) => {
  console.log('Request received:', req.body);
  const { phone } = req.body;

  fs.readFile(path.join(__dirname, 'public', 'members.json'), 'utf8', (err, data) => {
    if (err) {
      return res.status(500).send({ message: 'Error reading members file', error: err });
    }

    let members = [];
    if (data) {
      members = JSON.parse(data);
    }

    const updatedMembers = members.filter(member => member.phone !== phone);

    fs.writeFile(path.join(__dirname, 'public', 'members.json'), JSON.stringify(updatedMembers, null, 2), (err) => {
      if (err) {
        return res.status(500).send({ message: 'Error writing to members file', error: err });
      }

      res.status(200).send({ message: 'Member removed successfully' });
    });
  });
});

app.post('/addMember', (req, res) => {
  console.log('Request received:', req.body);
  const { name, phone } = req.body;
  const newMember = { name, phone };

  fs.readFile(path.join(__dirname, 'public', 'members.json'), 'utf8', (err, data) => {
    if (err) {
      return res.status(500).send({ message: 'Error reading members file', error: err });
    }

    let members = [];
    if (data) {
      members = JSON.parse(data);
    }

    members.push(newMember);

    fs.writeFile(path.join(__dirname, 'public', 'members.json'), JSON.stringify(members, null, 2), (err) => {
      if (err) {
        return res.status(500).send({ message: 'Error writing to members file', error: err });
      }

      res.status(200).send({ message: 'Member added successfully' });
    });
  });
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