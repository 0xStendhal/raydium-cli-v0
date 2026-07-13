"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadTokenMetadata = exports.uploadMetadataToIPFS = exports.uploadImageToIPFS = void 0;
const pinata_1 = require("pinata");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
function getMimeType(ext) {
    const mimeTypes = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
    };
    return mimeTypes[ext.toLowerCase()] || 'image/png';
}
async function uploadImageToIPFS(imagePath, apiKey) {
    if (!apiKey) {
        throw new Error('Pinata JWT not configured. Run: raydium config set pinata-jwt <your-jwt>\nGet a free JWT at https://pinata.cloud');
    }
    // Verify file exists and read it
    let imageBuffer;
    try {
        imageBuffer = await fs.readFile(imagePath);
    }
    catch {
        throw new Error(`Image file not found: ${imagePath}`);
    }
    const pinata = new pinata_1.PinataSDK({ pinataJwt: apiKey });
    const ext = path.extname(imagePath).slice(1) || 'png';
    const mimeType = getMimeType(ext);
    const fileName = path.basename(imagePath);
    // Create a File object from the buffer (convert to Uint8Array for type compatibility)
    const file = new File([new Uint8Array(imageBuffer)], fileName, { type: mimeType });
    try {
        const result = await pinata.upload.public.file(file);
        return `https://gateway.pinata.cloud/ipfs/${result.cid}`;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
            throw new Error('Invalid Pinata JWT. Get a new one at https://app.pinata.cloud/developers/api-keys');
        }
        throw new Error(`IPFS upload failed: ${message}`);
    }
}
exports.uploadImageToIPFS = uploadImageToIPFS;
async function uploadMetadataToIPFS(metadata, apiKey) {
    if (!apiKey) {
        throw new Error('Pinata JWT not configured. Run: raydium config set pinata-jwt <your-jwt>\nGet a free JWT at https://pinata.cloud');
    }
    const pinata = new pinata_1.PinataSDK({ pinataJwt: apiKey });
    try {
        const result = await pinata.upload.public.json(metadata);
        return `https://gateway.pinata.cloud/ipfs/${result.cid}`;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
            throw new Error('Invalid Pinata JWT. Get a new one at https://app.pinata.cloud/developers/api-keys');
        }
        throw new Error(`IPFS upload failed: ${message}`);
    }
}
exports.uploadMetadataToIPFS = uploadMetadataToIPFS;
async function uploadTokenMetadata(opts) {
    // 1. Upload image
    const imageUrl = await uploadImageToIPFS(opts.imagePath, opts.apiKey);
    // 2. Create and upload metadata
    const metadata = {
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
exports.uploadTokenMetadata = uploadTokenMetadata;
