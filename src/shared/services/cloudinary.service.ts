import crypto from 'crypto';
import { env } from '../../config/env.js';

export interface CloudinaryUploadResponse {
  secure_url: string;
  public_id: string;
  format: string;
  width: number;
  height: number;
}

/**
 * Uploads an image (base64 data URI or HTTP URL) to Cloudinary via REST API.
 */
export async function uploadToCloudinary(
  imageBase64OrUrl: string,
  folder: string = 'presence'
): Promise<string> {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  const timestamp = Math.floor(Date.now() / 1000);

  // Sign parameters alphabetically: folder, timestamp
  const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(signatureString).digest('hex');

  // Format image data URI if needed
  let fileData = imageBase64OrUrl;
  if (!fileData.startsWith('data:') && !fileData.startsWith('http://') && !fileData.startsWith('https://')) {
    fileData = `data:image/jpeg;base64,${fileData}`;
  }

  const formData = new URLSearchParams();
  formData.append('file', fileData);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp.toString());
  formData.append('folder', folder);
  formData.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Cloudinary upload error:', errorText);
    throw new Error('Failed to upload image to Cloudinary');
  }

  const result = (await response.json()) as CloudinaryUploadResponse;
  return result.secure_url;
}
