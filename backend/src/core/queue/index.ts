// Each playlist's queue (core): its song list in memory with queue_songs behind
// it (queue.ts) and the queue:* socket handlers (queueSockets.ts), registered
// per connection by app/sockets.ts with the playlist handlers' access checks.
export { Queue, getQueue, getQueueAsync, deleteQueue, hasQueue, cleanupOrphanedQueues, forgetAll, QueueUnavailableError } from './queue.ts';
export type { QueueSong, NewQueueSong, QueueSongChange } from './queue.ts';
export { createQueueSockets } from './queueSockets.ts';
export type { QueueSockets, QueueSocketsDeps, QueueSocketContext, QueueIo } from './queueSockets.ts';
