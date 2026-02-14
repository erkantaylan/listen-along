const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const chat = require('./chat');

describe('chat', () => {
  describe('isThrottled', () => {
    it('allows messages under the limit', () => {
      const socketId = 'test-socket-' + Date.now();
      assert.strictEqual(chat.isThrottled(socketId), false);
      assert.strictEqual(chat.isThrottled(socketId), false);
      chat.cleanupSocket(socketId);
    });

    it('throttles after exceeding limit', () => {
      const socketId = 'test-throttle-' + Date.now();
      // Send 5 messages (the limit)
      for (let i = 0; i < 5; i++) {
        chat.isThrottled(socketId);
      }
      // 6th should be throttled
      assert.strictEqual(chat.isThrottled(socketId), true);
      chat.cleanupSocket(socketId);
    });
  });

  describe('addMessage', () => {
    it('stores messages in memory', async () => {
      const lobbyId = 'test-lobby-' + Date.now();
      const msg = await chat.addMessage(lobbyId, 'user1', 'TestUser', '🎸', 'Hello world');

      assert.ok(msg.id);
      assert.strictEqual(msg.lobbyId, lobbyId);
      assert.strictEqual(msg.userId, 'user1');
      assert.strictEqual(msg.username, 'TestUser');
      assert.strictEqual(msg.emoji, '🎸');
      assert.strictEqual(msg.content, 'Hello world');
      assert.ok(msg.timestamp);
    });

    it('truncates long messages', async () => {
      const lobbyId = 'test-lobby-trunc-' + Date.now();
      const longContent = 'a'.repeat(600);
      const msg = await chat.addMessage(lobbyId, 'user1', 'Test', '', longContent);

      assert.strictEqual(msg.content.length, 500);
    });
  });

  describe('getHistory', () => {
    it('returns messages for a lobby', async () => {
      const lobbyId = 'test-history-' + Date.now();
      await chat.addMessage(lobbyId, 'user1', 'Alice', '🎸', 'First');
      await chat.addMessage(lobbyId, 'user2', 'Bob', '🎹', 'Second');

      const history = await chat.getHistory(lobbyId);
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].content, 'First');
      assert.strictEqual(history[1].content, 'Second');
    });

    it('returns empty array for unknown lobby', async () => {
      const history = await chat.getHistory('nonexistent-lobby');
      assert.deepStrictEqual(history, []);
    });

    it('respects the limit parameter', async () => {
      const lobbyId = 'test-limit-' + Date.now();
      for (let i = 0; i < 10; i++) {
        await chat.addMessage(lobbyId, 'user1', 'User', '', `Message ${i}`);
      }

      const history = await chat.getHistory(lobbyId, 3);
      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].content, 'Message 7');
    });
  });

  describe('cleanupLobby', () => {
    it('removes messages for a lobby', async () => {
      const lobbyId = 'test-cleanup-' + Date.now();
      await chat.addMessage(lobbyId, 'user1', 'User', '', 'Test');

      chat.cleanupLobby(lobbyId);

      const history = await chat.getHistory(lobbyId);
      assert.deepStrictEqual(history, []);
    });
  });
});
