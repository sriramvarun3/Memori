// Background Service Worker for Memori Extension
// Handles memory storage and retrieval using chrome.storage.local

const MAX_MEMORIES = 50;
const STORAGE_KEY = 'memori_memories';
const SETTINGS_KEY = 'memori_settings';

// Generate a simple UUID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Save a memory to storage (FIFO - keep last 50)
async function saveMemory(text, type = 'user') {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    let memories = result[STORAGE_KEY] || [];
    
    // Create new memory object
    const newMemory = {
      id: generateId(),
      text: text.trim(),
      timestamp: Date.now(),
      type: type // 'user' or 'assistant'
    };
    
    // Add to beginning of array
    memories.unshift(newMemory);
    
    // Keep only last MAX_MEMORIES entries
    if (memories.length > MAX_MEMORIES) {
      memories = memories.slice(0, MAX_MEMORIES);
    }
    
    // Save back to storage
    await chrome.storage.local.set({ [STORAGE_KEY]: memories });
    
    return { success: true, memory: newMemory };
  } catch (error) {
    console.error('Error saving memory:', error);
    return { success: false, error: error.message };
  }
}

// Get all memories from storage
async function getMemories() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] || [];
  } catch (error) {
    console.error('Error getting memories:', error);
    return [];
  }
}

// Delete a memory by ID
async function deleteMemory(memoryId) {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    let memories = result[STORAGE_KEY] || [];
    
    memories = memories.filter(m => m.id !== memoryId);
    
    await chrome.storage.local.set({ [STORAGE_KEY]: memories });
    return { success: true };
  } catch (error) {
    console.error('Error deleting memory:', error);
    return { success: false, error: error.message };
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveMemory') {
    saveMemory(request.text, request.type || 'user').then(sendResponse);
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getMemories') {
    getMemories().then(sendResponse);
    return true;
  }
  
  if (request.action === 'deleteMemory') {
    deleteMemory(request.memoryId).then(sendResponse);
    return true;
  }
  
  if (request.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }
  
  if (request.action === 'saveSettings') {
    saveSettings(request.settings).then(sendResponse);
    return true;
  }
  
  if (request.action === 'toggleSidebar') {
    // Forward toggle request to content script
    chrome.tabs.sendMessage(sender.tab.id, { action: 'toggleSidebar' });
    sendResponse({ success: true });
  }
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  // Only work on ChatGPT pages
  if (tab.url && (tab.url.includes('chat.openai.com') || tab.url.includes('chatgpt.com'))) {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' }).catch(err => {
      console.error('[Memori] Error sending message to content script:', err);
    });
  } else {
    console.log('[Memori] Not a ChatGPT page:', tab.url);
  }
});
