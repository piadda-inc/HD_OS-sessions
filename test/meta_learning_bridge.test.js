#!/usr/bin/env node
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const EventEmitter = require('events');
const MetaLearningBridge = require('../lib/meta_learning_bridge');

// Mock socket that emits events like net.Socket
class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.encoding = null;
    this.writtenData = [];
  }

  setEncoding(enc) {
    this.encoding = enc;
  }

  write(data, encoding, callback) {
    if (this.destroyed) {
      throw new Error('Socket is destroyed');
    }
    this.writtenData.push({ data, encoding });
    if (typeof callback === 'function') {
      setImmediate(callback);
    }
    return true;
  }

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      setImmediate(() => this.emit('close'));
    }
  }

  // Helper to simulate receiving data
  simulateData(data) {
    this.emit('data', data);
  }

  // Helper to simulate connection
  simulateConnect() {
    setImmediate(() => this.emit('connect'));
  }

  // Helper to simulate error
  simulateError(error) {
    this.emit('error', error);
  }

  // Helper to get written messages
  getWrittenMessages() {
    return this.writtenData.map(item => {
      const line = item.data;
      return JSON.parse(line.trim());
    });
  }
}

// Helper to create bridge with mock socket
function createMockBridge(options = {}) {
  const mockSocket = new MockSocket();
  const bridge = new MetaLearningBridge({
    socketPath: '/tmp/test.sock',
    requestTimeoutMs: 100,
    ...options,
  });

  // Add error handler to prevent unhandled errors
  bridge.on('error', () => {});

  // Store original createConnection
  const originalCreateConnection = net.createConnection;
  
  // Mock net.createConnection
  let restoreCalled = false;
  net.createConnection = function() {
    mockSocket.simulateConnect();
    return mockSocket;
  };

  return { 
    bridge, 
    mockSocket, 
    restore: () => {
      if (!restoreCalled) {
        net.createConnection = originalCreateConnection;
        restoreCalled = true;
      }
    }
  };
}

// Helper to setup connected bridge
async function setupConnectedBridge(options = {}) {
  const { bridge, mockSocket, restore } = createMockBridge(options);
  
  const connectPromise = bridge._connectIfNeeded();
  await new Promise(resolve => setImmediate(resolve));
  
  const handshakeId = mockSocket.getWrittenMessages()[0].id;
  mockSocket.simulateData(JSON.stringify({
    jsonrpc: '2.0',
    id: handshakeId,
    result: { status: 'ok' },
  }) + '\n');
  
  await connectPromise;
  mockSocket.writtenData = [];
  
  return { bridge, mockSocket, restore };
}

describe('MetaLearningBridge', () => {
  describe('Constructor', () => {
    test('initializes with default options', () => {
      const bridge = new MetaLearningBridge();
      assert.ok(bridge.socketPath.includes('.meta-learning.sock'));
      assert.strictEqual(bridge.host, '127.0.0.1');
      assert.strictEqual(bridge.port, 0);
      assert.strictEqual(bridge.requestTimeoutMs, 2000);
      assert.strictEqual(bridge.reconnectDelayMs, 250);
      assert.strictEqual(bridge.protocolVersion, 'v1');
      assert.ok(bridge.clientId.includes('cc-sessions/'));
    });

    test('accepts custom socketPath', () => {
      const bridge = new MetaLearningBridge({ socketPath: '/custom/path.sock' });
      assert.strictEqual(bridge.socketPath, '/custom/path.sock');
    });

    test('accepts custom host and port', () => {
      const bridge = new MetaLearningBridge({ host: '192.168.1.1', port: 9999 });
      assert.strictEqual(bridge.host, '192.168.1.1');
      assert.strictEqual(bridge.port, 9999);
    });

    test('accepts custom timeouts', () => {
      const bridge = new MetaLearningBridge({
        requestTimeoutMs: 5000,
        reconnectDelayMs: 1000,
      });
      assert.strictEqual(bridge.requestTimeoutMs, 5000);
      assert.strictEqual(bridge.reconnectDelayMs, 1000);
    });

    test('accepts custom protocol version and clientId', () => {
      const bridge = new MetaLearningBridge({
        protocolVersion: 'v2',
        clientId: 'test-client',
      });
      assert.strictEqual(bridge.protocolVersion, 'v2');
      assert.strictEqual(bridge.clientId, 'test-client');
    });

    test('resolves relative socket paths', () => {
      const bridge = new MetaLearningBridge({ socketPath: 'relative/path.sock' });
      assert.ok(bridge.socketPath.startsWith('/'));
    });
  });

  describe('Connection lifecycle', () => {
    test('connects and performs handshake', async () => {
      const { bridge, mockSocket, restore } = createMockBridge();

      const connectPromise = bridge._connectIfNeeded();
      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].method, 'meta.handshake');
      assert.strictEqual(messages[0].params.version, 'v1');
      assert.ok(messages[0].params.client.includes('cc-sessions/'));
      assert.deepStrictEqual(messages[0].params.capabilities, [
        'lifecycle',
        'strategy',
        'metrics',
        'dashboard',
      ]);

      const handshakeId = messages[0].id;
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: handshakeId,
        result: { status: 'ok' },
      }) + '\n');

      await connectPromise;

      assert.strictEqual(bridge._handshakeComplete, true);
      assert.strictEqual(bridge._socket, mockSocket);

      restore();
      await bridge.close();
    });

    test('reuses existing connection if handshake complete', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      // Second connection attempt should not create new handshake
      await bridge._connectIfNeeded();
      assert.strictEqual(mockSocket.writtenData.length, 0);

      restore();
      await bridge.close();
    });

    test('waits for in-flight connection', async () => {
      const { bridge, mockSocket, restore } = createMockBridge();

      const connect1 = bridge._connectIfNeeded();
      const connect2 = bridge._connectIfNeeded();

      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages.length, 1);

      const handshakeId = messages[0].id;
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: handshakeId,
        result: { status: 'ok' },
      }) + '\n');

      await Promise.all([connect1, connect2]);

      restore();
      await bridge.close();
    });

    test('closes socket and clears state', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      bridge._pending.set('test-id', {
        resolve: () => {},
        reject: () => {},
        method: 'test',
      });

      await bridge.close();

      assert.strictEqual(bridge._socket, null);
      assert.strictEqual(bridge._buffer, '');
      assert.strictEqual(bridge._handshakeComplete, false);
      assert.strictEqual(bridge._pending.size, 0);
      assert.ok(mockSocket.destroyed);

      restore();
    });
  });

  describe('RPC request/response handling', () => {
    test('sends RPC request and receives response', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', { foo: 'bar' });
      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].method, 'test.method');
      assert.deepStrictEqual(messages[0].params, { foo: 'bar' });

      const rpcId = messages[0].id;
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        result: { success: true },
      }) + '\n');

      const result = await rpcPromise;
      assert.deepStrictEqual(result, { success: true });

      restore();
      await bridge.close();
    });

    test('handles RPC error response', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));

      const rpcId = mockSocket.getWrittenMessages()[0].id;
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        error: { message: 'Method not found' },
      }) + '\n');

      await assert.rejects(rpcPromise, {
        message: 'Method not found',
      });

      restore();
      await bridge.close();
    });

    test('correlates multiple concurrent requests', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpc1 = bridge._rpc('method.one', { n: 1 });
      const rpc2 = bridge._rpc('method.two', { n: 2 });
      const rpc3 = bridge._rpc('method.three', { n: 3 });

      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages.length, 3);

      // Respond out of order
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[1].id,
        result: { value: 'second' },
      }) + '\n');

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[2].id,
        result: { value: 'third' },
      }) + '\n');

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[0].id,
        result: { value: 'first' },
      }) + '\n');

      const results = await Promise.all([rpc1, rpc2, rpc3]);
      assert.deepStrictEqual(results, [
        { value: 'first' },
        { value: 'second' },
        { value: 'third' },
      ]);

      restore();
      await bridge.close();
    });
  });

  describe('Timeout handling', () => {
    test('times out if no response received', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge({ requestTimeoutMs: 50 });

      const rpcPromise = bridge._rpc('test.method', {});

      await assert.rejects(rpcPromise, {
        message: /timeout after 50ms/,
      });

      restore();
      await bridge.close();
    });

    test('clears timeout on successful response', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge({ requestTimeoutMs: 1000 });

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));

      const rpcId = mockSocket.getWrittenMessages()[0].id;
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        result: { success: true },
      }) + '\n');

      const result = await rpcPromise;
      assert.deepStrictEqual(result, { success: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      restore();
      await bridge.close();
    });

    test('cleans up _pending map on timeout', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge({ requestTimeoutMs: 50 });

      assert.strictEqual(bridge._pending.size, 0, '_pending should start empty');

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));

      assert.strictEqual(bridge._pending.size, 1, '_pending should have 1 entry during RPC');

      await assert.rejects(rpcPromise, {
        message: /timeout after 50ms/,
      });

      assert.strictEqual(bridge._pending.size, 0, '_pending should be cleaned up after timeout');

      restore();
      await bridge.close();
    });

    test('does not cause unhandled rejection when late response arrives after timeout', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge({ requestTimeoutMs: 50 });

      const unhandledRejections = [];
      const rejectionHandler = (reason, promise) => {
        unhandledRejections.push({ reason, promise });
      };
      process.on('unhandledRejection', rejectionHandler);

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));
      const rpcId = mockSocket.getWrittenMessages()[0].id;

      await assert.rejects(rpcPromise, {
        message: /timeout after 50ms/,
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        result: { success: true },
      }) + '\n');

      await new Promise(resolve => setTimeout(resolve, 50));

      process.off('unhandledRejection', rejectionHandler);
      assert.strictEqual(unhandledRejections.length, 0, 'Should not have unhandled rejections');

      restore();
      await bridge.close();
    });

    test('cleans up _pending map on multiple concurrent timeouts', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge({ requestTimeoutMs: 50 });

      const rpc1 = bridge._rpc('test.method1', {});
      const rpc2 = bridge._rpc('test.method2', {});
      const rpc3 = bridge._rpc('test.method3', {});

      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(bridge._pending.size, 3, '_pending should have 3 entries');

      await Promise.allSettled([rpc1, rpc2, rpc3]);

      assert.strictEqual(bridge._pending.size, 0, '_pending should be fully cleaned up after all timeouts');

      restore();
      await bridge.close();
    });
  });

  describe('Frame buffering and parsing', () => {
    test('handles complete frame', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));
      const rpcId = mockSocket.getWrittenMessages()[0].id;

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        result: { data: 'complete' },
      }) + '\n');

      const result = await rpcPromise;
      assert.deepStrictEqual(result, { data: 'complete' });

      restore();
      await bridge.close();
    });

    test('handles fragmented frames', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));
      const rpcId = mockSocket.getWrittenMessages()[0].id;

      const fullMessage = JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        result: { data: 'fragmented' },
      }) + '\n';

      mockSocket.simulateData(fullMessage.slice(0, 20));
      mockSocket.simulateData(fullMessage.slice(20, 40));
      mockSocket.simulateData(fullMessage.slice(40));

      const result = await rpcPromise;
      assert.deepStrictEqual(result, { data: 'fragmented' });

      restore();
      await bridge.close();
    });

    test('handles multiple frames in one chunk', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpc1 = bridge._rpc('method.one', {});
      const rpc2 = bridge._rpc('method.two', {});

      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      const id1 = messages[0].id;
      const id2 = messages[1].id;

      const combined =
        JSON.stringify({ jsonrpc: '2.0', id: id1, result: { n: 1 } }) + '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: id2, result: { n: 2 } }) + '\n';

      mockSocket.simulateData(combined);

      const results = await Promise.all([rpc1, rpc2]);
      assert.deepStrictEqual(results, [{ n: 1 }, { n: 2 }]);

      restore();
      await bridge.close();
    });

    test('ignores empty lines', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));
      const rpcId = mockSocket.getWrittenMessages()[0].id;

      mockSocket.simulateData('\n\n');
      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        result: { data: 'ok' },
      }) + '\n\n\n');

      const result = await rpcPromise;
      assert.deepStrictEqual(result, { data: 'ok' });

      restore();
      await bridge.close();
    });
  });

  describe('Error handling', () => {
    test('emits error on invalid JSON', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const errorPromise = new Promise(resolve => {
        bridge.once('error', resolve);
      });

      mockSocket.simulateData('{ invalid json\n');

      const error = await errorPromise;
      assert.ok(error.message.includes('Invalid frame'));

      restore();
      await bridge.close();
    });

    test('rejects pending requests on socket error', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));

      const socketError = new Error('Connection reset');
      mockSocket.simulateError(socketError);

      await assert.rejects(rpcPromise);

      restore();
      await bridge.close();
    });

    test('rejects pending requests on socket close', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpcPromise = bridge._rpc('test.method', {});
      await new Promise(resolve => setImmediate(resolve));

      mockSocket.destroy();

      await assert.rejects(rpcPromise, {
        message: /socket closed/,
      });

      restore();
      await bridge.close();
    });

    test('throws error if RPC called on destroyed socket', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      mockSocket.destroy();

      await assert.rejects(bridge._rawRpc('test.method', {}), {
        message: /socket is not connected/,
      });

      restore();
      await bridge.close();
    });

    test('resets handshake flag on connection error', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      assert.strictEqual(bridge._handshakeComplete, true);

      mockSocket.simulateError(new Error('Connection lost'));

      assert.strictEqual(bridge._handshakeComplete, false);

      restore();
      await bridge.close();
    });
  });

  describe('Event emission', () => {
    test('emits notification for messages without id', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const notificationPromise = new Promise(resolve => {
        bridge.once('notification', resolve);
      });

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event.occurred',
        params: { data: 'notification' },
      }) + '\n');

      const notification = await notificationPromise;
      assert.strictEqual(notification.method, 'event.occurred');
      assert.deepStrictEqual(notification.params, { data: 'notification' });

      restore();
      await bridge.close();
    });

    test('emits notification for messages with unknown id', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const notificationPromise = new Promise(resolve => {
        bridge.once('notification', resolve);
      });

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: 'unknown-request-id',
        result: { data: 'orphan' },
      }) + '\n');

      const notification = await notificationPromise;
      assert.strictEqual(notification.id, 'unknown-request-id');
      assert.deepStrictEqual(notification.result, { data: 'orphan' });

      restore();
      await bridge.close();
    });

    test('emits error events', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const errorPromise = new Promise(resolve => {
        bridge.once('error', resolve);
      });

      const testError = new Error('Test error');
      mockSocket.simulateError(testError);

      const emittedError = await errorPromise;
      assert.strictEqual(emittedError, testError);

      restore();
      await bridge.close();
    });
  });

  describe('High-level API methods', () => {
    test('getStrategicContext sends correct RPC', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const resultPromise = bridge.getStrategicContext({ taskId: 'task-123' });
      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages[0].method, 'meta.getStrategicContext');
      assert.deepStrictEqual(messages[0].params, { taskId: 'task-123' });

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[0].id,
        result: { strategy: 'test-strategy' },
      }) + '\n');

      const result = await resultPromise;
      assert.strictEqual(result, 'test-strategy');

      restore();
      await bridge.close();
    });

    test('getStrategicContext returns null if no strategy', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const resultPromise = bridge.getStrategicContext({ taskId: 'task-123' });
      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[0].id,
        result: {},
      }) + '\n');

      const result = await resultPromise;
      assert.strictEqual(result, null);

      restore();
      await bridge.close();
    });

    test('emitLifecycleEvent sends correct RPC with timestamp', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const resultPromise = bridge.emitLifecycleEvent('task.start', {
        taskId: 'task-123',
        taskName: 'Test Task',
      });

      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages[0].method, 'meta.emitLifecycle');
      assert.strictEqual(messages[0].params.event, 'task.start');
      assert.strictEqual(messages[0].params.taskId, 'task-123');
      assert.strictEqual(messages[0].params.taskName, 'Test Task');
      assert.ok(messages[0].params.timestamp);
      assert.ok(messages[0].params.timestamp.includes('T'));

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[0].id,
        result: { received: true },
      }) + '\n');

      await resultPromise;

      restore();
      await bridge.close();
    });

    test('pushTaskMetrics sends correct RPC', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const snapshot = {
        taskId: 'task-123',
        duration: 1234,
        success: true,
      };

      const resultPromise = bridge.pushTaskMetrics(snapshot);
      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages[0].method, 'metrics.pushTaskMetrics');
      assert.deepStrictEqual(messages[0].params, snapshot);

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[0].id,
        result: { stored: true },
      }) + '\n');

      await resultPromise;

      restore();
      await bridge.close();
    });

    test('getDashboardSnapshot sends correct RPC', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const query = { timeRange: '7d' };
      const resultPromise = bridge.getDashboardSnapshot(query);

      await new Promise(resolve => setImmediate(resolve));

      const messages = mockSocket.getWrittenMessages();
      assert.strictEqual(messages[0].method, 'dashboard.getSnapshot');
      assert.deepStrictEqual(messages[0].params, query);

      const dashboardData = {
        metrics: { tasks: 10, success: 8 },
        patterns: [],
      };

      mockSocket.simulateData(JSON.stringify({
        jsonrpc: '2.0',
        id: messages[0].id,
        result: dashboardData,
      }) + '\n');

      const result = await resultPromise;
      assert.deepStrictEqual(result, dashboardData);

      restore();
      await bridge.close();
    });
  });

  describe('Clean shutdown', () => {
    test('close rejects pending requests with meaningful error', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      const rpc1 = bridge._rpc('method.one', {});
      const rpc2 = bridge._rpc('method.two', {});

      await new Promise(resolve => setImmediate(resolve));
      await bridge.close();

      await assert.rejects(rpc1, {
        message: 'MetaLearningBridge closed',
      });

      await assert.rejects(rpc2, {
        message: 'MetaLearningBridge closed',
      });

      restore();
    });

    test('close is idempotent', async () => {
      const { bridge, mockSocket, restore } = await setupConnectedBridge();

      await bridge.close();
      await bridge.close();
      await bridge.close();

      assert.ok(true);

      restore();
    });

    test('close without connection does not throw', async () => {
      const bridge = new MetaLearningBridge();
      bridge.on('error', () => {});
      await bridge.close();
      assert.ok(true);
    });
  });
});
