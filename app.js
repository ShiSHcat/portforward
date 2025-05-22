require('dotenv').config();
const requiredEnv = ['PORT', 'AUTH_USER', 'AUTH_PASS', 'SERVER_PUBLIC_IP'];
const missing = requiredEnv.filter(key => !process.env[key]);

if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please complete your .env file before starting the application.');
    process.exit(1); // Exit the app
}

const express = require('express');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const bodyParser = require('body-parser');
const { spawn, execSync } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 392;

app.use(basicAuth({
    users: { [process.env.AUTH_USER]: process.env.AUTH_PASS },
    challenge: true,
    realm: "FW Web"
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));

let portDB = {};
let killDB = {};

const SERVER_PUBLIC_IP = process.env.SERVER_PUBLIC_IP;

function ePort(port, protocol, method) {
    if (method === 'iptables') return `${port}_${protocol}_ipt`;
    return `${port}_${protocol}`;
}
function dPort(portProtocol) {
    const parts = portProtocol.split('_');
    if (parts.length === 2) return [parts[0], parts[1], 'socat'];
    if (parts.length === 3 && parts[2] === 'ipt') return [parts[0], parts[1], 'iptables'];
    return [parts[0], parts[1], 'socat'];
}
function decodePort(portProtocol, value) {
    let [port, protocol, method] = dPort(portProtocol);
    if (typeof value === 'string') {
        let [ip, toPort] = value.split(":");
        return { port, protocol, ip, toPort, method };
    }
    let { ip, toPort } = value;
    return { port, protocol, ip, toPort, method };
}

function startWatcher(protocol, port, ip, toPort) {
    const _protocol = protocol;
    protocol = protocol == "tcp" ? "TCP" : "UDP";
    let socat = spawn('/usr/bin/socat', [
        `${protocol}-LISTEN:${port},bind=0.0.0.0,reuseaddr,fork`,
        `${protocol}:${ip}:${toPort},reuseaddr`
    ]);
    let pid = socat.pid;
    killDB[ePort(port, _protocol, 'socat')] = pid;
    socat.stdout.on('data', (data) => console.log(`stdout ${pid}: ${data}`));
    socat.stderr.on('data', (data) => console.log(`stderr ${pid}: ${data}`));
    console.log(`Started socat watcher for ${protocol} port ${port} with pid ${pid}`);
}
function stopWatcher(port, protocol) {
    let pid = killDB[ePort(port, protocol, 'socat')];
    if (!pid) return;
    try { process.kill(pid, 'SIGKILL'); } catch (e) { }
    delete killDB[ePort(port, protocol, 'socat')];
    console.log(`Stopped socat watcher for ${port} with pid ${pid}`);
}

function iptablesAddForward(protocol, fromPort, toIp, toPort) {
    try {
        execSync(`iptables -t nat -A PREROUTING -p ${protocol} -d ${SERVER_PUBLIC_IP} --dport ${fromPort} -j DNAT --to-destination ${toIp}:${toPort}`);
        console.log(`Added iptables forward ${protocol} ${fromPort} => ${toIp}:${toPort}`);
    } catch (e) {
        console.error(e.stdout?.toString() || e.message);
        throw new Error("iptables add failed");
    }
}
function iptablesRemoveForward(protocol, fromPort, toIp, toPort) {
    try {
        execSync(`iptables -t nat -D PREROUTING -p ${protocol} -d ${SERVER_PUBLIC_IP} --dport ${fromPort} -j DNAT --to-destination ${toIp}:${toPort}`);
        console.log(`Removed iptables forward ${protocol} ${fromPort} => ${toIp}:${toPort}`);
    } catch (e) {
        console.error(e.stdout?.toString() || e.message);
    }
}

function syncPortDB() {
    if (!fs.existsSync('./ports.json')) {
        fs.writeFileSync('./ports.json', '{}');
    }
    portDB = JSON.parse(fs.readFileSync('./ports.json'));
    for (const port in portDB) {
        const { port: p, protocol, ip, toPort, method } = decodePort(port, portDB[port]);
        if (method === 'iptables') {
            iptablesRemoveForward(protocol, p, ip, toPort);
        } else {
            stopWatcher(p, protocol);
        }
    }
    for (const port in portDB) {
        const { port: p, protocol, ip, toPort, method } = decodePort(port, portDB[port]);
        if (method === 'iptables') {
            iptablesAddForward(protocol, p, ip, toPort);
        } else {
            startWatcher(protocol, p, ip, toPort);
        }
    }
}
function savePortDB() {
    fs.writeFileSync('./ports.json', JSON.stringify(portDB, null, 4));
}

// Sync on start
syncPortDB();

app.get('/', (req, res) => {
    let entries = [];
    for (let key in portDB) {
        let { port, protocol, ip, toPort, method } = decodePort(key, portDB[key]);
        entries.push({ port, protocol, ip, toPort, method });
    }
    res.render('index', { entries });
});

app.post('/add', (req, res) => {
    let { ip, port, toPort, protocol, method } = req.body;
    protocol = protocol.toLowerCase();
    method = method || "socat";
    if (!['tcp', 'udp'].includes(protocol)) return res.send('Invalid protocol');
    if (!ip.match(/^[0-9.]+$/)) return res.send('Invalid IP');
    if (!port.match(/^[0-9]+$/)) return res.send('Invalid port');
    if (!toPort.match(/^[0-9]+$/)) return res.send('Invalid toPort');
    const key = ePort(port, protocol, method);
    if (portDB[key]) return res.send('Port already forwarded');
    if (method === "socat") {
        startWatcher(protocol, port, ip, toPort);
    } else if (method === "iptables") {
        try {
            iptablesRemoveForward(protocol, port, ip, toPort);
            iptablesAddForward(protocol, port, ip, toPort);
        } catch (e) {
            return res.send("iptables add failed: " + e.message);
        }
    }
    portDB[key] = `${ip}:${toPort}`;
    savePortDB();
    res.redirect('/');
});

app.post('/remove', (req, res) => {
    let { port, protocol, method } = req.body;
    protocol = protocol.toLowerCase();
    method = method || "socat";
    const key = ePort(port, protocol, method);
    let entry = portDB[key];
    if (!entry) return res.send('Port not forwarded');
    let { ip, toPort } = decodePort(key, entry);
    if (method === "socat") {
        stopWatcher(port, protocol);
    } else if (method === "iptables") {
        iptablesRemoveForward(protocol, port, ip, toPort);
    }
    delete portDB[key];
    savePortDB();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Web FW listening at port ${PORT}`);
});
