import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

// Loaded only into the isolated historical-contract test process. An attempt
// fails the process even if code catches the exception; no request is dispatched.
let attempts = 0;
const deny = () => {
  attempts++;
  throw new Error('NETWORK_DISABLED_IN_GOURMET_CONTRACT_TESTS');
};
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
// tsx 4.23.15 tries its parent's local pipe for optional loader notifications.
// Deny that IPC too, without misreporting it as an external network attempt.
const loaderPipe = join(tmpdir(), `tsx-${process.geteuid?.() ?? userInfo().username}`, `${process.ppid}.pipe`);
const denySocket = (...args) => {
  if (args[0] === loaderPipe) throw new Error('TSX_LOADER_IPC_DISABLED_IN_CONTRACT_TESTS');
  return deny();
};
net.connect = net.createConnection = net.Socket.prototype.connect = denySocket;
tls.connect = dgram.createSocket = deny;
dgram.Socket.prototype.send = deny;
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (/^(lookup|resolve|reverse)/.test(name) && typeof target[name] === 'function') target[name] = deny;
  }
}
syncBuiltinESMExports();
process.once('exit', () => {
  if (attempts) {
    process.stderr.write(`Blocked contract-test network attempts: ${attempts}\n`);
    process.exitCode = 1;
  }
});
