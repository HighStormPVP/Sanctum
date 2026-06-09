const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  config: () => ipcRenderer.invoke('config:get'),
  catalog: () => ipcRenderer.invoke('models:catalog'),

  ollama: {
    detect: () => ipcRenderer.invoke('ollama:detect'),
    start:  () => ipcRenderer.invoke('ollama:start'),
    install: async (onChunk) => {
      const { channelId } = await ipcRenderer.invoke('ollama:install');
      return new Promise((resolve) => {
        const handler = (_e, payload) => {
          onChunk(payload);
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve();
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    list: () => ipcRenderer.invoke('ollama:list'),
    pull: async (tag, onChunk) => {
      const { channelId } = await ipcRenderer.invoke('ollama:pull', tag);
      return new Promise((resolve) => {
        const handler = (_e, payload) => {
          onChunk({ ...payload, _channelId: channelId });
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve();
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    pullAbort: (channelId, removeFiles) =>
      ipcRenderer.invoke('ollama:pull-abort', { channelId, removeFiles }),
    chat: async ({ model, messages, images, tools, options }, onChunk) => {
      const { channelId } = await ipcRenderer.invoke('ollama:chat', { model, messages, images, tools, options });
      return new Promise((resolve) => {
        const handler = (_e, payload) => {
          // Surface the channelId on each chunk so the renderer can wire stop.
          onChunk({ ...payload, _channelId: channelId });
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve();
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    chatAbort: (channelId) => ipcRenderer.invoke('ollama:chat-abort', channelId)
  },

  files: {
    pick:       () => ipcRenderer.invoke('file:pick'),
    pickFolder: () => ipcRenderer.invoke('file:pick-folder'),
    fromPath:   (filePath) => ipcRenderer.invoke('file:from_path', { path: filePath }),
    // Extract a real filesystem path from a drag-and-drop File. Electron 32+
    // removed File.prototype.path; webUtils.getPathForFile is the replacement.
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file); }
      catch { return file?.path || ''; }
    }
  },

  media: {
    cache: (sourceUrl) => ipcRenderer.invoke('media:cache', sourceUrl)
  },

  web: {
    search: (query) => ipcRenderer.invoke('web:search', query),
    fetch:  (url)   => ipcRenderer.invoke('web:fetch', url)
  },

  fs: {
    readFile:   (p, allowlist)              => ipcRenderer.invoke('fs:read_file', p, allowlist),
    listDir:    (p, allowlist)              => ipcRenderer.invoke('fs:list_dir', p, allowlist),
    writeFile:  (p, content, allowlist)     => ipcRenderer.invoke('fs:write_file', { path: p, content, allowlist }),
    applyPatch: (p, find, replace, allowlist) => ipcRenderer.invoke('fs:apply_patch', { path: p, find, replace, allowlist }),
    glob:       (pattern, root, allowlist)  => ipcRenderer.invoke('fs:glob', { pattern, root, allowlist }),
    grep:       (pattern, root, opts)       => ipcRenderer.invoke('fs:grep', { pattern, root, ...opts })
  },

  audit: {
    log:  (entry) => ipcRenderer.invoke('audit:log', entry),
    path: () => ipcRenderer.invoke('audit:path'),
    open: () => ipcRenderer.invoke('audit:open')
  },

  mcp: {
    list:     ()             => ipcRenderer.invoke('mcp:list'),
    add:      (name, config) => ipcRenderer.invoke('mcp:add', { name, config }),
    remove:   (name)         => ipcRenderer.invoke('mcp:remove', { name }),
    restart:  (name)         => ipcRenderer.invoke('mcp:restart', { name }),
    getTools: ()             => ipcRenderer.invoke('mcp:get_tools'),
    callTool: (name, args)   => ipcRenderer.invoke('mcp:call_tool', { name, args }),
    onUpdate: (handler) => {
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on('mcp:updated', wrapped);
      return () => ipcRenderer.removeListener('mcp:updated', wrapped);
    }
  },

  shell: {
    run:        (command, cwd) => ipcRenderer.invoke('shell:run', { command, cwd }),
    runAsync:   (command, cwd, allowlist) => ipcRenderer.invoke('shell:run_async', { command, cwd, allowlist }),
    taskStatus: (taskId) => ipcRenderer.invoke('shell:task_status', taskId),
    taskList:   () => ipcRenderer.invoke('shell:task_list'),
    taskKill:   (taskId) => ipcRenderer.invoke('shell:task_kill', taskId),
    // Streaming run for the code-block ▷ Run button. onChunk receives:
    //   { kind: 'start', taskId, command }
    //   { kind: 'stdout' | 'stderr', text }
    //   { kind: 'exit', exitCode, status, done, runtimeMs }
    //   { kind: 'error', text, done }
    runCode: async ({ lang, code }, onChunk) => {
      const { channelId, taskId } = await ipcRenderer.invoke('shell:run_code_stream', { lang, code });
      return new Promise((resolve) => {
        const handler = (_e, payload) => {
          onChunk(payload);
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve({ taskId });
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    runCodeKill: (taskId) => ipcRenderer.invoke('shell:run_code_kill', taskId)
  },

  // Video Analysis pipeline. All long-running ops use the channelId pattern so
  // the renderer can show progress in real time.
  video: {
    detectDeps: () => ipcRenderer.invoke('video:detect_deps'),
    installDep: async ({ dep }, onChunk) => {
      const { channelId } = await ipcRenderer.invoke('video:install_dep', { dep });
      return new Promise((resolve) => {
        const handler = (_e, payload) => {
          onChunk(payload);
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve(payload);
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    probe: (videoPath) => ipcRenderer.invoke('video:probe', { videoPath }),
    extract: async ({ videoPath, chatId, fps }, onChunk) => {
      const { channelId } = await ipcRenderer.invoke('video:extract', { videoPath, chatId, fps });
      return new Promise((resolve) => {
        const handler = (_e, payload) => {
          // Surface the channelId on every chunk so the renderer can wire abort.
          onChunk({ ...payload, _channelId: channelId });
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve({ ...payload, _channelId: channelId });
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    transcribe: async ({ audioPath, model }, onChunk) => {
      const { channelId } = await ipcRenderer.invoke('video:transcribe', { audioPath, model });
      return new Promise((resolve) => {
        let transcript = null;
        const handler = (_e, payload) => {
          if (payload.kind === 'transcript') transcript = payload.data;
          onChunk({ ...payload, _channelId: channelId });
          if (payload.done) {
            ipcRenderer.removeListener(channelId, handler);
            resolve({ ...payload, transcript, _channelId: channelId });
          }
        };
        ipcRenderer.on(channelId, handler);
      });
    },
    readFrame:    (framePath) => ipcRenderer.invoke('video:read_frame', { framePath }),
    cleanupChat:  (chatId) => ipcRenderer.invoke('video:cleanup_chat', { chatId }),
    abort:        (channelId) => ipcRenderer.invoke('video:abort', { channelId })
  }
});
