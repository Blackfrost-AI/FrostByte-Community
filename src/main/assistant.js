import path from 'node:path';
import { app, ipcMain } from 'electron';
import { AssistantService } from './assistant-service.js';
import { runtimeModels, RUNTIME_NAMES, MANAGED_PROVIDER, runtimeModel } from './assistant-runtimes.js';
import { ManagedLlamaRuntime, llamaManifestRoot, verifyLlamaRuntime } from './llama-runtime.js';
import { sparkRequest } from './spark.js';
import { RemoteChatStream, remoteDeviceModels } from './assistant-remote.js';
import { streamChatCompletion } from './assistant-chat.js';

export function registerAssistant({ handle, devices, modelLibrary }) {
  const remoteStreams = new Map();
  let currentSender = null;
  const managed = new ManagedLlamaRuntime({
    modelLibrary,
    verify: () => verifyLlamaRuntime({ root: llamaManifestRoot(process.resourcesPath), resourcesPath: process.resourcesPath }),
  });
  const assistant = new AssistantService({
    directory: path.join(app.getPath('userData'), 'assistant'),
    local: async () => {
      const rows = await Promise.all(RUNTIME_NAMES.map(async provider => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try { return await runtimeModels(provider, { signal: controller.signal }); }
        catch (error) {
          if (error?.name !== 'AbortError') throw error;
          return { provider, status: 'offline', models: [], error: 'Runtime is unavailable.' };
        } finally { clearTimeout(timer); }
      }));
      // Managed fallback: saved GGUF models that no running server already offers.
      const advertised = new Set(rows.flatMap(row => row.models).map(model => model.name));
      const managedStatus = managed.status();
      const managedModels = managedStatus.available
        ? managed.loadableModels().filter(model => !advertised.has(model.name))
            .map(model => runtimeModel('local', MANAGED_PROVIDER, model.name, managedStatus.running && managedStatus.model === model.name ? 'ready' : 'available'))
        : [];
      rows.push({ provider: MANAGED_PROVIDER, status: managedStatus.available ? (managedModels.length ? 'ready' : 'empty') : 'offline', models: managedModels });
      return { models: rows.flatMap(row => row.models), runtimes: rows.map(row => ({ provider: row.provider, status: row.status })) };
    },
    listDevices: async () => devices.list().map(device => ({ id: device.id, name: device.hostLabel || device.host || 'Paired device' })),
    remote: id => remoteDeviceModels(devices, sparkRequest, id),
    chat: async (request, options) => {
      if (request.model.deviceId === 'local') {
        if (request.model.provider === MANAGED_PROVIDER) {
          const session = await managed.ensureLoaded(request.model.name, { signal: options.signal });
          managed.touch();
          return streamChatCompletion({ ...request, model: { ...request.model, port: session.port } }, { ...options, apiKey: session.apiKey });
        }
        return streamChatCompletion(request, options);
      }
      const deviceId = request.model.deviceId;
      const approval = devices.approvalSnapshot(deviceId);
      const device = devices.profile(deviceId);
      const stream = new RemoteChatStream({ stream: options.stream, send: async payload => sparkRequest(device, payload, { timeout: 15000 }) });
      remoteStreams.set(options.stream, stream);
      // Stop must tear down the SSH channel so the companion sees the socket
      // close and aborts generation; the explicit cancel action also travels
      // the restricted RPC allowlist as a second, belt-and-braces path.
      const transportAbort = new AbortController();
      const abortTransport = () => transportAbort.abort();
      options.signal?.addEventListener('abort', abortTransport, { once: true });
      // Revoke or replace the pairing mid-stream and the generation dies with it.
      const approvalWatch = setInterval(() => {
        if (!devices.isApprovalCurrent(approval)) { options.onEvent?.({ type: 'cancelled' }); abortTransport(); }
      }, 1000);
      approvalWatch.unref?.();
      let streamBroken = false;
      const failStream = () => {
        if (streamBroken) return;
        streamBroken = true;
        try { options.onEvent?.({ type: 'error', message: 'The device sent an invalid chat stream.' }); } catch { /* renderer may be gone */ }
        abortTransport();
      };
      try {
        await sparkRequest(device, { action: 'assistant:chat:start', stream: options.stream, model: request.model, messages: request.messages }, {
          signal: transportAbort.signal,
          onOutput: (value, source) => {
            // This callback runs inside the SSH data listener: a throw here
            // would escape as an uncaughtException and kill the app. Every
            // failure path must degrade to a chat error, never a throw.
            try {
              if (streamBroken || source === 'stderr') return;
              if (!devices.isApprovalCurrent(approval)) { abortTransport(); return; }
              stream.push(Buffer.from(value), options.onEvent);
            } catch { failStream(); }
          },
        });
        if (streamBroken) throw new Error('The device sent an invalid chat stream.');
        if (!devices.isApprovalCurrent(approval)) throw new Error('The saved device connection changed during this chat.');
        if (options.signal?.aborted) throw new Error('cancelled');
        if (!stream.terminal) throw new Error('The device ended the chat unexpectedly.');
      } finally {
        clearInterval(approvalWatch);
        options.signal?.removeEventListener('abort', abortTransport);
        try { await stream.cancel(); } catch { /* The transport may already be gone; the agent aborts on socket close. */ }
        remoteStreams.delete(options.stream);
      }
    },
    onEvent: event => { if (currentSender && !currentSender.isDestroyed()) currentSender.send('runtime:event', event); },
  });
  handle('runtime:models', refresh => assistant.catalog({ refresh: refresh === true }));
  handle('runtime:conversations', () => assistant.conversations());
  handle('runtime:new', () => assistant.create());
  handle('runtime:history', id => assistant.history(id));
  handle('runtime:clear', () => assistant.clear());
  handle('chat:cancel', id => assistant.cancel(id));
  handle('chat:stream', (input, event) => {
    currentSender = event.sender;
    if (assistant.active.size >= 4) throw new Error('Too many chats are running. Stop one before starting another.');
    return assistant.send(input);
  }, { withEvent: true });
  assistant.stopManagedRuntime = () => managed.stop();
  return assistant;
}
