import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Backups to an S3-compatible endpoint (D133).
 *
 * ## Why this and not SMB
 *
 * D130 chose to speak SMB from Node rather than mount a share, to avoid giving
 * a container `CAP_SYS_ADMIN`. The reasoning held; the protocol did not. Both
 * Node SMB clients authenticate with **NTLMv1** — one of them through OpenSSL's
 * DES, which no longer exists, and the other through its own — and current
 * Samba and Windows refuse NTLMv1 by default. Writing NTLMv2 by hand is
 * authentication code, which is the category where a subtle error is silent.
 * D132 has the whole account.
 *
 * S3 needs none of it: an HTTP request signed with a key the owner pastes in.
 * The same protocol reaches AWS, Backblaze B2, MinIO, and the S3 endpoint most
 * NAS boxes now ship. Somebody who wants a Windows share mounts it on the host
 * and points a **directory** destination at the mount, which has always worked
 * and needs nothing from this file.
 *
 * ## What is deliberate here
 *
 * **`forcePathStyle` is a setting, not a guess.** AWS wants
 * `bucket.host/key`; MinIO and most NAS endpoints want `host/bucket/key` and
 * fail confusingly on the other. It defaults to on, because self-hosted is the
 * case this project is for.
 *
 * **The dump is already encrypted when it arrives here.** That is D103's rule
 * and it is what makes any remote destination acceptable: what crosses the wire
 * is ciphertext with a GCM tag, not a database. Server-side encryption is not
 * requested and would add nothing, since the bytes are opaque before they leave.
 *
 * **No `@aws-sdk/lib-storage`.** A dump is one stream and one object; the
 * multipart uploader exists for objects large enough to need parts, and adding
 * a second dependency to avoid a `PutObject` is not a trade worth making. If a
 * database ever outgrows a single PUT, that is the moment to add it.
 */

export type S3Target = {
  /** Empty means AWS itself, which is the one case the SDK can infer. */
  endpoint: string;
  region: string;
  bucket: string;
  /** A folder inside the bucket. Empty means the root of it. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export function s3ClientFor(target: S3Target): S3Client {
  return new S3Client({
    /**
     * A region is mandatory in the SDK's eyes even where the endpoint ignores
     * it. MinIO and most NAS boxes do ignore it; `us-east-1` is the
     * conventional filler and is what their own documentation uses.
     */
    region: target.region.trim() || "us-east-1",
    ...(target.endpoint.trim() === "" ? {} : { endpoint: target.endpoint.trim() }),
    forcePathStyle: target.forcePathStyle,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
    /**
     * Three attempts, not the SDK's default of three-plus-adaptive-backoff.
     * A scheduled backup that cannot reach its destination should fail while
     * somebody is still awake, and the run row records the reason either way.
     */
    maxAttempts: 3,
  });
}

/** `prefix/name`, with no leading or doubled slashes. Empty prefix is the root. */
export function objectKey(prefix: string, name: string): string {
  const clean = prefix.trim().replace(/^\/+|\/+$/g, "");
  return clean === "" ? name : `${clean}/${name}`;
}

/**
 * Uploads one object and reports how many bytes went.
 *
 * `ContentLength` is passed explicitly because the body is a `Buffer` whose
 * length is known: without it the SDK falls back to chunked encoding, which
 * some S3-compatible endpoints reject outright.
 */
export async function putObject(
  client: S3Client,
  target: S3Target,
  name: string,
  body: Buffer,
): Promise<number> {
  await client.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: objectKey(target.prefix, name),
      Body: body,
      ContentLength: body.length,
      ContentType: "application/octet-stream",
    }),
  );
  return body.length;
}

export async function deleteObject(
  client: S3Client,
  target: S3Target,
  name: string,
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({ Bucket: target.bucket, Key: objectKey(target.prefix, name) }),
  );
}

export type RemoteBackup = { key: string; name: string; lastModified: Date | null };

/**
 * Every backup object under the prefix, oldest first.
 *
 * Paged, because a bucket kept for a year at one a day is 365 objects and
 * `ListObjectsV2` returns a thousand at a time — fine today, and the kind of
 * limit that is discovered the hard way when it is not.
 */
export async function listBackups(
  client: S3Client,
  target: S3Target,
): Promise<RemoteBackup[]> {
  const found: RemoteBackup[] = [];
  let token: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: objectKey(target.prefix, "vikt-"),
        ContinuationToken: token,
      }),
    );

    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (key === undefined) continue;
      const name = key.slice(key.lastIndexOf("/") + 1);
      if (!/^vikt-.*\.dump\.enc$/.test(name)) continue;
      found.push({ key, name, lastModified: object.LastModified ?? null });
    }

    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);

  return found.sort(
    (a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0),
  );
}

/**
 * Reads a stream into memory.
 *
 * Honest about what it costs: the whole dump is buffered before it is sent. A
 * `PutObject` needs a length, the alternative is the multipart uploader, and a
 * database whose compressed dump does not fit in memory is a database that has
 * outgrown a single-container deployment for several other reasons first. The
 * local destination still streams to disk and does not go through here.
 */
export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * What to tell the owner when the destination refuses.
 *
 * The SDK's own message for a bad secret is "The request signature we
 * calculated does not match the signature you provided", which is accurate and
 * tells somebody staring at an admin screen nothing about which of six fields
 * to look at. Each of these names the field.
 *
 * The names come from the errors MinIO actually returned during development,
 * not from the documentation.
 */
export function explainS3Error(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);

  if (name === "SignatureDoesNotMatch") {
    return "The secret key is wrong. The access key reached the server and the signature did not match it.";
  }
  if (name === "InvalidAccessKeyId") {
    return "The access key is wrong: the server does not know it.";
  }
  if (name === "NoSuchBucket") {
    return "There is no bucket by that name on this endpoint.";
  }
  if (name === "AccessDenied" || name === "Forbidden") {
    return (
      "The key is valid and is not allowed to do this. It needs PutObject, " +
      "ListBucket and DeleteObject on this bucket."
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/.test(message) || name === "TimeoutError") {
    return `Could not reach the endpoint (${message}). Check the address, the port and whether it is http or https.`;
  }
  if (name === "PermanentRedirect" || /region/i.test(message)) {
    return `The endpoint answered but not for this bucket or region (${message}). A NAS or MinIO usually needs the path-style option on.`;
  }
  return message;
}
