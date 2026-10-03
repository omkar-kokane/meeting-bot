import express from 'express';
import client from 'prom-client';
import config, { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import { globalJobStore } from '../lib/globalJobStore';
import { RedisConsumerService } from '../connect/RedisConsumerService';

const app = express();

app.use(express.json());

// Initialize Redis consumer service
export const redisConsumerService = new RedisConsumerService();

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  // Use the job store's isBusy status
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  return res.status(200).json({ success: true, data: jobStoreBusy });
});

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  // Use the job store's isBusy status for metrics
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  busyStatus.set(jobStoreBusy);
  isavailable.set(1 - jobStoreBusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/debug', async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

app.use('/google', googleRouter);
app.use('/microsoft', microsoftRouter);
app.use('/zoom', zoomRouter);

// Serve the RecordMeet UI
import path from 'path';
import fs from 'fs';
app.use(express.static(path.join(process.cwd(), 'ui')));

// List all saved local recordings
app.get('/recordings', async (req, res) => {
  try {
    const recordingsRoot = path.join(process.cwd(), 'recordings');
    if (!fs.existsSync(recordingsRoot)) {
      return res.json({ success: true, data: [] });
    }
    const users = fs.readdirSync(recordingsRoot);
    const files: object[] = [];
    for (const user of users) {
      const userDir = path.join(recordingsRoot, user);
      if (!fs.statSync(userDir).isDirectory()) continue;
      const userFiles = fs.readdirSync(userDir);
      for (const file of userFiles) {
        const filePath = path.join(userDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          files.push({
            name: file,
            userId: user,
            sizeBytes: stat.size,
            createdAt: stat.birthtime,
            modifiedAt: stat.mtime,
            downloadUrl: `/recordings/download/${user}/${encodeURIComponent(file)}`,
          });
        }
      }
    }
    // Sort newest first
    files.sort((a: any, b: any) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    return res.json({ success: true, data: files });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// Download a specific recording
app.get('/recordings/download/:userId/:filename', (req, res) => {
  const filePath = path.join(process.cwd(), 'recordings', req.params.userId, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }
  res.download(filePath);
});

// Bot status: is there an active recording session?
app.get('/status', async (req, res) => {
  const busy = globalJobStore.isBusy();
  return res.json({ success: true, data: { active: busy } });
});

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// Start Redis consumer service only if Redis is enabled
if (config.isRedisEnabled) {
  redisConsumerService.start().catch((error) => {
    console.error('Failed to start Redis consumer service:', error);
  });
} else {
  console.info('Redis consumer service not started - Redis is disabled');
}

export default app;
