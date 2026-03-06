const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guided', {
  // --- Session Control ---
  startSession: (goal, role) => ipcRenderer.invoke('session:start', goal, role),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  sendMessage: (text) => ipcRenderer.invoke('session:message', text),
  nextStep: () => ipcRenderer.invoke('session:next-step'),
  backOnTrack: () => ipcRenderer.invoke('session:back-on-track'),
  dismiss: () => ipcRenderer.invoke('session:dismiss'),
  closeWindow: () => ipcRenderer.send('popup:close'),
  openSettings: () => ipcRenderer.send('popup:open-settings'),

  // --- Window Resize ---
  resizeWindow: (width, height) => ipcRenderer.send('popup:resize', width, height),

  // --- Session Events (Main -> Renderer) ---
  onStepUpdate: (cb) => {
    ipcRenderer.on('step:update', (_e, data) => cb(data));
  },
  onOffTrack: (cb) => {
    ipcRenderer.on('step:off-track', (_e, data) => cb(data));
  },
  onSessionEnd: (cb) => {
    ipcRenderer.on('session:ended', (_e, data) => cb(data));
  },
  onSessionError: (cb) => {
    ipcRenderer.on('session:error', (_e, msg) => cb(msg));
  },
  onLoading: (cb) => {
    ipcRenderer.on('session:loading', (_e, loading) => cb(loading));
  },
  onAppDetected: (cb) => {
    ipcRenderer.on('session:app-detected', (_e, appName) => cb(appName));
  },

  // --- Dashboard Events ---
  onSwitchTab: (cb) => {
    ipcRenderer.on('dashboard:switch-tab', (_e, tab) => cb(tab));
  },

  // --- Dashboard Data ---
  getSessions: () => ipcRenderer.invoke('dashboard:sessions'),
  getSession: (id) => ipcRenderer.invoke('dashboard:session', id),
  getProfiles: () => ipcRenderer.invoke('dashboard:profiles'),
  getProfile: (appName) => ipcRenderer.invoke('dashboard:profile', appName),
  updateProfile: (appName, data) => ipcRenderer.invoke('dashboard:update-profile', appName, data),
  deleteProfile: (appName) => ipcRenderer.invoke('dashboard:delete-profile', appName),

  // --- Settings ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // --- Knowledge Base ---
  scrapeHelpCenter: (appName, url) => ipcRenderer.invoke('knowledge:scrape', appName, url),
  getKnowledgeStatus: (appName) => ipcRenderer.invoke('knowledge:status', appName),

  // --- Profile AI Interview ---
  sendProfileChat: (appName, message) => ipcRenderer.invoke('profile:chat', appName, message),
});
