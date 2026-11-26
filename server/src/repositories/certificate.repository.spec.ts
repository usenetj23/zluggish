import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { connect } from 'node:tls';

const repository = new CertificateRepository();
const now = new Date();
const material = await repository.create({ serverId: '0123456789ab', years: 5, now });

/** Whether a TLS client that trusts only `ca` accepts the server for `servername`. */
async function handshake(ca: string, servername: string) {
  const server = createServer({ cert: material.cert, key: material.key });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // SAFETY: a TCP server listening on a host and port reports an AddressInfo.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { port } = server.address() as AddressInfo;
    const socket = connect({ host: '127.0.0.1', port, servername, ca });

    try {
      await once(socket, 'secureConnect');

      return true;
    } catch {
      return false;
    } finally {
      socket.destroy();
    }
  } finally {
    server.close();
  }
}

await test('the generated certificate is a self-signed ECDSA P-256 end-entity certificate for the Zwift names', () => {
  const certificate = new X509Certificate(material.cert);

  assert.equal(certificate.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.equal(new CryptoRepository().certificateFacts(material.cert).key, 'ECDSA P-256');
  assert.ok(certificate.verify(certificate.publicKey));
  assert.equal(certificate.ca, false);
  assert.equal(certificate.subject, 'O=Zluggish\nOU=Zluggish server 0123456789ab\nCN=*.zwift.com');
  assert.equal(certificate.issuer, certificate.subject);
  assert.equal(certificate.subjectAltName, 'DNS:*.zwift.com, DNS:zwift.com');
  assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.ok(certificate.checkHost('secure.zwift.com'));
  assert.equal(certificate.checkHost('example.com'), undefined);
  // Valid from a little before creation, for five years.
  assert.ok(certificate.validFromDate < now && now.getTime() - certificate.validFromDate.getTime() <= 10 * 60_000);
  const expires = new Date(now);
  expires.setUTCFullYear(expires.getUTCFullYear() + 5);
  assert.equal(certificate.validToDate.getTime(), Math.floor(expires.getTime() / 1000) * 1000);
});

await test('a client that trusts the certificate connects for every Zwift name and no other', async () => {
  assert.equal(await handshake(material.cert, 'secure.zwift.com'), true);
  assert.equal(await handshake(material.cert, 'us-or-rly101.zwift.com'), true);
  assert.equal(await handshake(material.cert, 'example.com'), false);
  const other = await repository.create({ serverId: 'ffffffffffff', years: 5, now });
  assert.equal(await handshake(other.cert, 'secure.zwift.com'), false);
});

await test('the stored key and certificate round-trip, are private, and a mismatched pair is refused', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'zluggish-certificate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'tls', 'zwift-server.pem');

  assert.equal(repository.read(path), null);
  await repository.write(path, material);
  assert.deepEqual(repository.read(path), material);

  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const other = await repository.create({ serverId: 'ffffffffffff', years: 1, now });
  writeFileSync(path, other.key + material.cert);
  assert.throws(() => repository.read(path), /does not hold a matching private key and certificate/);
});
