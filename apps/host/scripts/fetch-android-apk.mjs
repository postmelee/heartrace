import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const sourceUrl = process.env.ANDROID_APK_SOURCE_URL;
const expectedSha256 = process.env.ANDROID_APK_SHA256?.toLowerCase();
const outputPath = resolve("dist/downloads/simjangdalrigi-android.apk");

if (!sourceUrl || !expectedSha256) {
  throw new Error(
    "ANDROID_APK_SOURCE_URL and ANDROID_APK_SHA256 are required for the Render build.",
  );
}

await mkdir(dirname(outputPath), { recursive: true });

const response = await fetch(sourceUrl, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`Android APK download failed with HTTP ${response.status}.`);
}

const hash = createHash("sha256");
const hashStream = new Transform({
  transform(chunk, _encoding, callback) {
    hash.update(chunk);
    callback(null, chunk);
  },
});

await pipeline(
  Readable.fromWeb(response.body),
  hashStream,
  createWriteStream(outputPath),
);

const actualSha256 = hash.digest("hex");
if (actualSha256 !== expectedSha256) {
  throw new Error(
    `Android APK checksum mismatch: expected ${expectedSha256}, received ${actualSha256}.`,
  );
}

const { size } = await stat(outputPath);
if (size < 10_000_000) {
  throw new Error(`Android APK is unexpectedly small: ${size} bytes.`);
}

console.log(
  `Verified Android APK for static deployment (${size} bytes, ${actualSha256}).`,
);
