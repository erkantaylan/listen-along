const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Set up test covers directory before importing module
const TEST_COVERS_DIR = '/tmp/test-covers-' + Date.now();
process.env.COVERS_DIR = TEST_COVERS_DIR;

const covers = require('./covers');

describe('covers module', () => {
  beforeEach(() => {
    // Ensure clean test directory
    if (fs.existsSync(TEST_COVERS_DIR)) {
      fs.rmSync(TEST_COVERS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_COVERS_DIR)) {
      fs.rmSync(TEST_COVERS_DIR, { recursive: true });
    }
  });

  describe('isAvailable', () => {
    it('returns true when directory is writable', () => {
      const result = covers.isAvailable();
      assert.strictEqual(result, true);
    });
  });

  describe('getCachedCover', () => {
    it('returns null for non-existent cover', () => {
      const result = covers.getCachedCover('nonexistent-id');
      assert.strictEqual(result, null);
    });

    it('returns cover info when file exists', () => {
      // Create a test cover file
      if (!fs.existsSync(TEST_COVERS_DIR)) {
        fs.mkdirSync(TEST_COVERS_DIR, { recursive: true });
      }
      const testPath = path.join(TEST_COVERS_DIR, 'test-song.jpg');
      fs.writeFileSync(testPath, 'fake image data');

      const result = covers.getCachedCover('test-song');
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.path, testPath);
      assert.strictEqual(result.contentType, 'image/jpeg');
    });

    it('finds covers with different extensions', () => {
      if (!fs.existsSync(TEST_COVERS_DIR)) {
        fs.mkdirSync(TEST_COVERS_DIR, { recursive: true });
      }
      const testPath = path.join(TEST_COVERS_DIR, 'test-png.png');
      fs.writeFileSync(testPath, 'fake png data');

      const result = covers.getCachedCover('test-png');
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.contentType, 'image/png');
    });
  });

  describe('cacheCover', () => {
    it('returns null for null thumbnail URL', async () => {
      const result = await covers.cacheCover('song-id', null);
      assert.strictEqual(result, null);
    });

    it('returns null for empty thumbnail URL', async () => {
      const result = await covers.cacheCover('song-id', '');
      assert.strictEqual(result, null);
    });

    it('downloads and caches image from URL', async () => {
      // Create a simple HTTP server to serve a test image
      const testImageData = Buffer.from('fake image content');
      const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(testImageData);
      });

      await new Promise(resolve => server.listen(0, resolve));
      const port = server.address().port;

      try {
        const result = await covers.cacheCover('download-test', `http://localhost:${port}/test.jpg`);
        assert.notStrictEqual(result, null);
        assert.ok(fs.existsSync(result));

        const cached = covers.getCachedCover('download-test');
        assert.notStrictEqual(cached, null);
        assert.strictEqual(cached.contentType, 'image/jpeg');
      } finally {
        server.close();
      }
    });

    it('handles HTTP errors gracefully', async () => {
      const server = http.createServer((req, res) => {
        res.statusCode = 404;
        res.end('Not found');
      });

      await new Promise(resolve => server.listen(0, resolve));
      const port = server.address().port;

      try {
        const result = await covers.cacheCover('error-test', `http://localhost:${port}/notfound.jpg`);
        assert.strictEqual(result, null);
      } finally {
        server.close();
      }
    });
  });
});
