/**
 * uploadClient.ts
 * UploadThing v7 direct-upload helper.
 */
import { UTApi } from "uploadthing/server";

export const utapi = new UTApi();

/** Upload a single file Buffer to UploadThing and return { url, key }. */
export async function uploadBuffer(
  buffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<{ url: string; key: string }> {
  // Convert Buffer to Uint8Array for Blob compatibility in TS
  const uint8 = new Uint8Array(buffer);
  const blob = new Blob([uint8], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });

  const response = await utapi.uploadFiles([file]);
  const first = response[0];
  if (first.error) {
    throw new Error(`UploadThing error: ${first.error.message}`);
  }
  return { url: first.data.ufsUrl, key: first.data.key };
}

/** Delete a file from UploadThing by key. */
export async function deleteByKey(key: string): Promise<void> {
  await utapi.deleteFiles([key]);
}
