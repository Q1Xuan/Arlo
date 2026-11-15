import crypto from 'node:crypto';

function derLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derInteger(num: number | Buffer): Buffer {
  const buf = typeof num === 'number' ? Buffer.from([num]) : num;
  return derTag(0x02, buf);
}

function derBitString(buf: Buffer): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derUtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const str =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return derTag(0x17, Buffer.from(str, 'ascii'));
}

// OID: sha256WithRSAEncryption 1.2.840.113549.1.1.11
const OID_SHA256_RSA = derTag(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]));
const ALG_SHA256_RSA = derSeq(OID_SHA256_RSA, derTag(0x05, Buffer.alloc(0)));

// Name: CN=127.0.0.1 (OID 2.5.4.3: 0x55, 0x04, 0x03)
const OID_CN = derTag(0x06, Buffer.from([0x55, 0x04, 0x03]));
const CN_VAL = derTag(0x0c, Buffer.from('127.0.0.1')); // UTF8String
const NAME_CN = derSeq(derTag(0x31, derSeq(OID_CN, CN_VAL)));

// SAN extension: OID 2.5.29.17: 0x55, 0x1d, 0x11
const OID_SAN = derTag(0x06, Buffer.from([0x55, 0x1d, 0x11]));
// SAN value: iPAddress [7] 127.0.0.1, dNSName [2] localhost
const SAN_IP = derTag(0x87, Buffer.from([127, 0, 0, 1]));
const SAN_DNS = derTag(0x82, Buffer.from('localhost'));
const SAN_DER = derSeq(SAN_IP, SAN_DNS);
const EXT_SAN = derSeq(OID_SAN, derTag(0x04, SAN_DER));
const EXTENSIONS = derTag(0xa3, derSeq(EXT_SAN));

export interface GeneratedTlsCredentials {
  certPem: string;
  keyPem: string;
}

export function generateSelfSignedLoopbackCert(validDays = 365): GeneratedTlsCredentials {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const now = new Date();
  // The application clock can run slightly ahead of the TLS verifier's clock.
  // Permit a short skew at issuance without extending expiry or weakening pinning.
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(now.getTime() + validDays * 24 * 3600 * 1000);
  const validity = derSeq(derUtcTime(notBefore), derUtcTime(notAfter));

  const version = derTag(0xa0, derInteger(2)); // v3
  // A fixed positive prefix keeps every random suffix nonzero and minimally
  // encoded in DER, including suffixes beginning with 00, FF or a sign bit.
  const serial = derInteger(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(8)]));

  const tbs = derSeq(version, serial, ALG_SHA256_RSA, NAME_CN, validity, NAME_CN, spkiDer, EXTENSIONS);
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = derSeq(tbs, ALG_SHA256_RSA, derBitString(signature));

  const certLines = certDer.toString('base64').match(/.{1,64}/g) ?? [];
  const certPem = '-----BEGIN CERTIFICATE-----\n' + certLines.join('\n') + '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  return { certPem, keyPem };
}
