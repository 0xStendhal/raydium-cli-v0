import { PinataSDK } from 'pinata';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface TokenMetadata {
  name: string;
  symbol: string;
  description?: string;
  image: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  showName?: boolean;
  createdOn?: string;
}

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
  };
  return mimeTypes[ext.toLowerCase()] || 'image/png';
}

export async function uploadImageToIPFS(imagePath: string, apiKey: string): Promise<string> {
  if (!apiKey) {
    throw new Error('Pinata JWT not configured. Run: raydium config set pinata-jwt <your-jwt>\nGet a free JWT at https://pinata.cloud');
  }

  // Verify file exists and read it
  let imageBuffer: Buffer;
  try {
    imageBuffer = await fs.readFile(imagePath);
  } catch {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const pinata = new PinataSDK({ pinataJwt: apiKey });
  const ext = path.extname(imagePath).slice(1) || 'png';
  const mimeType = getMimeType(ext);
  const fileName = path.basename(imagePath);

  // Create a File object from the buffer (convert to Uint8Array for type compatibility)
  const file = new File([new Uint8Array(imageBuffer)], fileName, { type: mimeType });

  try {
    const result = await pinata.upload.public.file(file);
    return `https://gateway.pinata.cloud/ipfs/${result.cid}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
      throw new Error('Invalid Pinata JWT. Get a new one at https://app.pinata.cloud/developers/api-keys');
    }
    throw new Error(`IPFS upload failed: ${message}`);
  }
}

export async function uploadMetadataToIPFS(metadata: TokenMetadata, apiKey: string): Promise<string> {
  if (!apiKey) {
    throw new Error('Pinata JWT not configured. Run: raydium config set pinata-jwt <your-jwt>\nGet a free JWT at https://pinata.cloud');
  }

  const pinata = new PinataSDK({ pinataJwt: apiKey });

  try {
    const result = await pinata.upload.public.json(metadata);
    return `https://gateway.pinata.cloud/ipfs/${result.cid}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
      throw new Error('Invalid Pinata JWT. Get a new one at https://app.pinata.cloud/developers/api-keys');
    }
    throw new Error(`IPFS upload failed: ${message}`);
  }
}

export async function uploadTokenMetadata(opts: {
  imagePath: string;
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  apiKey: string;
}): Promise<{ uri: string; imageUrl: string }> {
  // 1. Upload image
  const imageUrl = await uploadImageToIPFS(opts.imagePath, opts.apiKey);

  // 2. Create and upload metadata
  const metadata: TokenMetadata = {
    name: opts.name,
    symbol: opts.symbol,
    image: imageUrl,
    description: opts.description || `${opts.name} token`,
    showName: true,
    createdOn: 'https://raydium.io',
    ...(opts.twitter && { twitter: opts.twitter }),
    ...(opts.telegram && { telegram: opts.telegram }),
    ...(opts.website && { website: opts.website }),
  };

  const uri = await uploadMetadataToIPFS(metadata, opts.apiKey);

  return { uri, imageUrl };
}
