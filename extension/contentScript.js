// Content Script for Memori Extension
// Injects UI elements into ChatGPT page and handles interactions

console.log('[Memori] Content script file loaded!', window.location.href);

let sidebarVisible = false;
let sidebarContainer = null;
let saveButton = null;
let autoCaptureEnabled = false;
let mSendButton = null;
let mSendInProgress = false;

// ChatGPT input selectors (may need updates if ChatGPT changes their DOM)
const INPUT_SELECTORS = [
  'textarea[data-id="root"]',
  'textarea#prompt-textarea',
  'textarea[data-testid="chat-input"]',
  'div.ProseMirror[contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  'div[contenteditable="true"][aria-label*="gemini" i]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="message" i]',
  'textarea[aria-label*="message" i]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea[data-testid*="textbox"]',
  'textarea[data-testid*="input"]',
  'textarea',
  'div[contenteditable="true"]'
];

const SEND_BUTTON_SELECTORS = [
  'button[data-testid*="send"]',
  'button[data-testid="send-button"]',
  'button[aria-label*="Send to Gemini" i]',
  'button[aria-label*="Run" i]',
  'button[aria-label*="Send message" i]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="send" i]',
  'button:has(svg[data-testid*="send"])',
  'form button[type="submit"]',
  'button[type="submit"]'
];

// Check if element is visible
function isElementVisible(element) {
  if (!element) return false;
  
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  
  // Check if element is hidden
  if (style.display === 'none' || 
      style.visibility === 'hidden' || 
      style.opacity === '0' ||
      rect.width === 0 ||
      rect.height === 0) {
    return false;
  }
  
  // Check if element is off-screen
  if (rect.top < -1000 || rect.left < -1000) {
    return false;
  }
  
  return true;
}

// Find ChatGPT input element - prioritize visible elements
function findChatGPTInput() {
  // First pass: try to find visible elements
  for (const selector of INPUT_SELECTORS) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (isElementVisible(element)) {
        // Double check it has some content or is the active element
        const hasContent = element.value || element.innerText || element.textContent;
        const isActive = document.activeElement === element || element === document.activeElement?.closest(selector);
        
        // Prefer elements with content or that are active
        if (hasContent || isActive) {
          console.log('[Memori] Found visible input with selector:', selector, 'hasContent:', !!hasContent, 'isActive:', isActive);
          return element;
        }
      }
    }
  }
  
  // Second pass: if no visible element found, try to find any element that's not explicitly hidden
  for (const selector of INPUT_SELECTORS) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      const style = window.getComputedStyle(element);
      // Skip only if explicitly hidden
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        console.log('[Memori] Found input (may not be fully visible) with selector:', selector);
        return element;
      }
    }
  }
  
  console.warn('[Memori] No input element found');
  return null;
}

// Find ChatGPT send button
function findChatGPTSendButton() {
  for (const selector of SEND_BUTTON_SELECTORS) {
    try {
      const candidates = document.querySelectorAll(selector);
      for (const el of candidates) {
        if (isElementVisible(el) && !el.disabled) {
          return el;
        }
      }
    } catch (_) {
      // Ignore invalid selectors in changing DOMs
    }
  }
  return null;
}

// Extract text from input (reusable function)
function extractTextFromInput(input) {
  if (!input) return '';
  
  let text = '';
  
  if (input.tagName === 'TEXTAREA') {
    text = input.value || '';
  } else if (input.contentEditable === 'true' || input.isContentEditable) {
    // For contenteditable, try multiple methods
    // Method 1: innerText (most reliable, ignores HTML)
    text = input.innerText || '';
    
    // Method 2: textContent if innerText is empty
    if (!text.trim()) {
      text = input.textContent || '';
    }
    
    // Method 3: Use Range API to get all text
    if (!text.trim()) {
      try {
        const range = document.createRange();
        range.selectNodeContents(input);
        text = range.toString().trim();
      } catch (e) {
        // Range might fail, continue
      }
    }
    
    // Method 4: Walk through text nodes
    if (!text.trim()) {
      const walker = document.createTreeWalker(
        input,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        const nodeText = node.textContent.trim();
        if (nodeText) {
          textNodes.push(nodeText);
        }
      }
      text = textNodes.join(' ');
    }
    
    // Method 5: Try getting from selection (if user just typed)
    if (!text.trim()) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        text = selection.toString().trim();
      }
    }
  } else {
    text = input.value || input.innerText || input.textContent || '';
  }
  
  // If still no text, try finding visible child elements
  if (!text.trim()) {
    // Look for visible textarea in children
    const textAreas = input.querySelectorAll('textarea');
    for (const ta of textAreas) {
      if (isElementVisible(ta) && ta.value) {
        text = ta.value;
        break;
      }
    }
    
    // Look for visible contenteditable children
    if (!text.trim()) {
      const editables = input.querySelectorAll('[contenteditable="true"]');
      for (const ed of editables) {
        if (isElementVisible(ed)) {
          const edText = ed.innerText || ed.textContent || '';
          if (edText.trim()) {
            text = edText.trim();
            break;
          }
        }
      }
    }
  }
  
  return text.trim();
}

// Shared button style for Memori action buttons
const MEMORI_BUTTON_STYLE = `
  padding: 10px 16px;
  background: #10a37f;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  transition: background 0.2s;
`;

// Create API key modal (shown when key not stored)
function createApiKeyModal() {
  const overlay = document.createElement('div');
  overlay.id = 'memori-api-key-modal';
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;
  overlay.innerHTML = `
    <div style="background: white; padding: 24px; border-radius: 12px; max-width: 420px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.2);">
      <h3 style="margin: 0 0 12px; font-size: 18px;">OpenAI API Key Required</h3>
      <p style="margin: 0 0 16px; font-size: 14px; color: #6b7280;">Export Context uses OpenAI to compress conversations. Get a key at:</p>
      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" style="font-size: 13px; color: #10a37f;">platform.openai.com/api-keys</a>
      <input type="password" id="memori-api-key-input" placeholder="Paste your API key" style="width: 100%; margin: 16px 0; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="memori-api-key-cancel" style="padding: 8px 16px; background: #e5e7eb; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">Cancel</button>
        <button id="memori-api-key-save" style="padding: 8px 16px; background: #10a37f; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">Save & Continue</button>
      </div>
    </div>
  `;
  return overlay;
}

// Show API key modal, resolve with key or null if cancelled
function showApiKeyModal() {
  return new Promise((resolve) => {
    const existing = document.getElementById('memori-api-key-modal');
    if (existing) existing.remove();
    const modal = createApiKeyModal();
    document.body.appendChild(modal);
    const input = modal.querySelector('#memori-api-key-input');
    const saveBtn = modal.querySelector('#memori-api-key-save');
    const cancelBtn = modal.querySelector('#memori-api-key-cancel');
    input.focus();
    saveBtn.addEventListener('click', () => {
      const key = input.value?.trim();
      if (key) {
        chrome.runtime.sendMessage({ action: 'saveOpenAIApiKey', key });
        modal.remove();
        resolve(key);
      }
    });
    cancelBtn.addEventListener('click', () => {
      modal.remove();
      resolve(null);
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
        resolve(null);
      }
    });
  });
}

function setChatGPTInputText(input, text) {
  if (!input) return false;

  if (input.tagName === 'TEXTAREA') {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (input.contentEditable === 'true' || input.isContentEditable) {
    input.focus();
    // Select all existing content then replace via execCommand so that
    // ProseMirror/Quill editors honour newlines and paragraph breaks.
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  return false;
}

function triggerChatGPTSend(input) {
  const sendBtn = findChatGPTSendButton();
  if (sendBtn) {
    sendBtn.click();
    return true;
  }

  if (input) {
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13,
      bubbles: true
    });
    input.dispatchEvent(enterEvent);
    return true;
  }

  return false;
}

async function handleGranolaGroundedMSend() {
  if (mSendInProgress) return;

  const input = findChatGPTInput();
  if (!input) {
    alert('Could not find ChatGPT input');
    return;
  }

  const userQuery = extractTextFromInput(input);
  if (!userQuery) {
    alert('Type a message first');
    return;
  }

  mSendInProgress = true;
  if (mSendButton) {
    mSendButton.disabled = true;
    mSendButton.textContent = 'M...';
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'granolaGroundedComposePrompt',
      userQuery
    });

    if (!result?.success || !result.composedPrompt) {
      alert(result?.error || 'Could not prepare grounded prompt');
      return;
    }

    const didSet = setChatGPTInputText(input, result.composedPrompt);
    if (!didSet) {
      alert('Could not write grounded prompt into ChatGPT input');
      return;
    }

    // Give ChatGPT editor a tick to reconcile the input update.
    setTimeout(() => {
      triggerChatGPTSend(input);
    }, 50);
  } catch (error) {
    console.error('[Memori] M-send failed:', error);
    alert(error.message || 'M-send failed');
  } finally {
    mSendInProgress = false;
    if (mSendButton) {
      mSendButton.disabled = false;
      mSendButton.textContent = 'M';
    }
  }
}

function createMSendButton() {
  const button = document.createElement('button');
  button.id = 'memori-m-send-btn';
  button.type = 'button';
  button.textContent = 'M';
  button.title = 'Ground with Granola and send';
  button.style.cssText = `
    margin-right: 8px;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid #10a37f;
    background: #ffffff;
    color: #10a37f;
    font-weight: 700;
    cursor: pointer;
    font-size: 13px;
  `;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleGranolaGroundedMSend();
  });
  return button;
}

function injectMSendButtonNearSend() {
  const sendBtn = findChatGPTSendButton();
  if (!sendBtn) return;

  const existing = document.getElementById('memori-m-send-btn');
  if (existing && existing.parentElement && existing.parentElement.contains(sendBtn)) {
    mSendButton = existing;
    return;
  }
  if (existing) existing.remove();

  const mBtn = createMSendButton();
  sendBtn.parentElement?.insertBefore(mBtn, sendBtn);
  mSendButton = mBtn;
}

// Create "Save to memory" button
function createSaveButton() {
  const button = document.createElement('button');
  button.id = 'memori-save-btn';
  button.textContent = '💾 Save to memory';
  button.style.cssText = MEMORI_BUTTON_STYLE + `
    position: relative;
    width: 100%;
  `;
  
  button.addEventListener('mouseenter', () => {
    button.style.background = '#0d8c6d';
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.background = '#10a37f';
  });
  
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const input = findChatGPTInput();
    if (!input) {
      alert('Could not find ChatGPT input box');
      return;
    }
    
    console.log('[Memori] Found input element:', {
      tagName: input.tagName,
      id: input.id,
      className: input.className,
      visible: isElementVisible(input),
      display: window.getComputedStyle(input).display
    });
    
    // Get text from input using the reusable function
    const text = extractTextFromInput(input);
    console.log('[Memori] Final extracted text length:', text.length, 'Preview:', text.substring(0, 100));
    
    if (!text.trim()) {
      alert('Input box is empty. Found input element: ' + input.tagName + ' (id: ' + (input.id || 'none') + ')');
      console.log('[Memori] Input element:', input);
      console.log('[Memori] Input properties:', {
        tagName: input.tagName,
        value: input.value,
        innerText: input.innerText,
        textContent: input.textContent,
        contentEditable: input.contentEditable,
        isContentEditable: input.isContentEditable
      });
      return;
    }
    
    // Send to background script to save
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'saveMemory',
        text: text
      });
      
      if (response.success) {
        // Visual feedback
        button.textContent = '✓ Saved!';
        button.style.background = '#059669';
        setTimeout(() => {
          button.textContent = '💾 Save to memory';
          button.style.background = '#10a37f';
        }, 1500);
        
        // Refresh sidebar if visible
        if (sidebarVisible) {
          loadMemoriesIntoSidebar();
        }
      } else {
        alert('Failed to save memory: ' + (response.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error saving memory:', error);
      alert('Error saving memory');
    }
  });
  
  return button;
}

// Create Export Context button (smart compression via OpenAI)
function createExportContextButton() {
  const button = document.createElement('button');
  button.id = 'memori-export-context-btn';
  button.textContent = '📋 Export Context';
  button.style.cssText = MEMORI_BUTTON_STYLE + `
    position: relative;
    width: 100%;
  `;
  button.addEventListener('mouseenter', () => { button.style.background = '#0d8c6d'; });
  button.addEventListener('mouseleave', () => { button.style.background = '#10a37f'; });
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const conversation = extractFullConversation();
    if (conversation.length === 0) {
      alert('No conversation found to export');
      return;
    }
    let apiKey = null;
    try {
      const r = await chrome.runtime.sendMessage({ action: 'getOpenAIApiKey' });
      apiKey = r?.key?.trim();
    } catch (_) {}
    if (!apiKey) {
      apiKey = await showApiKeyModal();
      if (!apiKey) return;
    }
    button.disabled = true;
    button.textContent = 'Compressing...';
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'compressAndSaveContext',
        conversation
      });
      if (result.success) {
        button.textContent = `✓ Exported (${result.messageCount} msgs)`;
        if (sidebarVisible) loadContextHandoffsIntoSidebar();
        setTimeout(() => {
          button.textContent = '📋 Export Context';
          button.disabled = false;
        }, 2500);
      } else {
        if (result.needsApiKey) {
          apiKey = await showApiKeyModal();
          if (apiKey) button.click();
        } else {
          alert(result.error || 'Export failed');
        }
        button.textContent = '📋 Export Context';
        button.disabled = false;
      }
    } catch (err) {
      console.error('[Memori] Export context error:', err);
      alert(err.message || 'Export failed');
      button.textContent = '📋 Export Context';
      button.disabled = false;
    }
  });
  return button;
}

// Create button container (Save + Export Context, stacked)
function createMemoriButtonContainer() {
  const container = document.createElement('div');
  container.id = 'memori-button-container';
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 999998;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    overflow: hidden;
    width: 180px;
  `;
  const exportBtn = createExportContextButton();
  const saveBtn = createSaveButton();
  container.appendChild(exportBtn);
  container.appendChild(saveBtn);
  return container;
}

// Inject save button into ChatGPT input area
function injectSaveButton() {
  const existing = document.getElementById('memori-button-container');
  if (existing) existing.remove();
  
  const input = findChatGPTInput();
  if (!input) {
    console.log('[Memori] Input not found, will retry...');
    return;
  }
  
  console.log('[Memori] Found input element, injecting buttons');
  const container = createMemoriButtonContainer();
  saveButton = container.querySelector('#memori-save-btn');
  document.body.appendChild(container);
}

// Create sidebar container
function createSidebar() {
  if (sidebarContainer) {
    console.log('[Memori] Sidebar already exists');
    return sidebarContainer;
  }
  
  console.log('[Memori] Creating new sidebar element');
  
  const sidebar = document.createElement('div');
  sidebar.id = 'memori-sidebar';
  sidebar.innerHTML = `
    <div id="memori-sidebar-header">
      <h3>Memori</h3>
      <button id="memori-close-btn">×</button>
    </div>
    <div id="memori-sidebar-settings">
      <label class="memori-toggle-label">
        <input type="checkbox" id="memori-auto-capture-toggle">
        <span>Auto-capture sent messages</span>
      </label>
      <div id="memori-openai-key-row" style="margin-top: 12px;">
        <label style="font-size: 12px; color: #6b7280;">OpenAI API Key</label>
        <div style="display: flex; gap: 8px; margin-top: 4px; align-items: center;">
          <input type="password" id="memori-openai-key-input" placeholder="API key for Export Context" style="flex: 1; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 12px;">
          <button id="memori-openai-key-save" style="padding: 8px 12px; background: #10a37f; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">Save</button>
        </div>
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" style="font-size: 11px; color: #10a37f; margin-top: 4px; display: block;">Get key at platform.openai.com</a>
        <span id="memori-openai-key-status" style="font-size: 11px; color: #6b7280; margin-top: 4px; display: block;"></span>
      </div>
    </div>
    <div id="memori-sidebar-tabs">
      <button class="memori-tab-btn active" data-tab="memories">Memories</button>
      <button class="memori-tab-btn" data-tab="contexts">Context Handoffs</button>
      <button class="memori-tab-btn" data-tab="granola">Granola</button>
    </div>
    <div id="memori-sidebar-content">
      <div id="memori-memories-panel" class="memori-tab-panel">
        <div id="memori-memories-list"></div>
      </div>
      <div id="memori-contexts-panel" class="memori-tab-panel" style="display:none"></div>
      <div id="memori-granola-list" class="memori-tab-panel" style="display:none"></div>
    </div>
  `;
  
  // Inject CSS directly (more reliable than loading external file)
  if (!document.getElementById('memori-sidebar-styles')) {
    const style = document.createElement('style');
    style.id = 'memori-sidebar-styles';
    style.textContent = `
      #memori-sidebar {
        position: fixed;
        top: 0;
        right: -400px;
        width: 380px;
        height: 100vh;
        background: #ffffff;
        box-shadow: -2px 0 10px rgba(0, 0, 0, 0.1);
        z-index: 999999;
        transition: right 0.3s ease;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }
      #memori-sidebar.memori-sidebar-visible {
        right: 0 !important;
      }
      #memori-sidebar-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid #e5e7eb;
        background: #f9fafb;
      }
      #memori-sidebar-settings {
        padding: 12px 20px;
        border-bottom: 1px solid #e5e7eb;
        background: #ffffff;
      }
      .memori-toggle-label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #374151;
        cursor: pointer;
        user-select: none;
      }
      .memori-toggle-label input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: #10a37f;
      }
      .memori-toggle-label span {
        flex: 1;
      }
      #memori-sidebar-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #111827;
      }
      #memori-close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: #6b7280;
        cursor: pointer;
        padding: 0;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background 0.2s;
      }
      #memori-close-btn:hover {
        background: #e5e7eb;
        color: #111827;
      }
      #memori-sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 0;
      }
      #memori-memories-list {
        padding: 12px;
      }
      .memori-memory-item {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
        transition: box-shadow 0.2s;
      }
      .memori-memory-item:hover {
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      .memori-memory-item.memori-chat-export {
        border-left: 3px solid #8b5cf6;
      }
      .memori-memory-item.memori-chat-export .memori-memory-text {
        max-height: 250px;
      }
      .memori-memory-text {
        color: #374151;
        font-size: 14px;
        line-height: 1.5;
        margin-bottom: 10px;
        word-wrap: break-word;
        white-space: pre-wrap;
        max-height: 150px;
        overflow-y: auto;
      }
      .memori-memory-actions {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
      }
      .memori-inject-btn, .memori-delete-btn {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.2s;
        font-family: inherit;
      }
      .memori-inject-btn {
        background: #10a37f;
        color: white;
        flex: 1;
      }
      .memori-inject-btn:hover {
        background: #0d8c6d;
      }
      .memori-delete-btn {
        background: #ef4444;
        color: white;
      }
      .memori-delete-btn:hover {
        background: #dc2626;
      }
      .memori-empty, .memori-error {
        padding: 40px 20px;
        text-align: center;
        color: #6b7280;
        font-size: 14px;
      }
      .memori-error {
        color: #ef4444;
      }
      #memori-sidebar-content::-webkit-scrollbar {
        width: 6px;
      }
      #memori-sidebar-content::-webkit-scrollbar-track {
        background: #f1f1f1;
      }
      #memori-sidebar-content::-webkit-scrollbar-thumb {
        background: #c1c1c1;
        border-radius: 3px;
      }
      #memori-sidebar-content::-webkit-scrollbar-thumb:hover {
        background: #a8a8a8;
      }
      #memori-sidebar-tabs {
        display: flex;
        border-bottom: 1px solid #e5e7eb;
        background: #f9fafb;
      }
      .memori-tab-btn {
        flex: 1;
        padding: 10px 16px;
        border: none;
        background: transparent;
        font-size: 13px;
        font-weight: 500;
        color: #6b7280;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.2s;
      }
      .memori-tab-btn:hover {
        color: #111827;
        background: #f3f4f6;
      }
      .memori-tab-btn.active {
        color: #10a37f;
        background: #ffffff;
        border-bottom: 2px solid #10a37f;
      }
      .memori-tab-panel {
        padding: 12px;
      }
      #memori-memories-panel {
        padding: 12px;
      }
      .memori-context-item {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-left: 3px solid #8b5cf6;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .memori-context-item .memori-context-title {
        font-weight: 600;
        color: #111827;
        font-size: 14px;
        margin-bottom: 4px;
      }
      .memori-context-item .memori-context-meta {
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 8px;
      }
      .memori-context-item .memori-context-preview {
        font-size: 13px;
        color: #374151;
        max-height: 80px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-wrap: break-word;
        margin-bottom: 8px;
      }
      .memori-context-item.expanded .memori-context-preview {
        max-height: 300px;
      }
      .memori-context-expand-btn {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        background: #e5e7eb;
        color: #374151;
        font-family: inherit;
      }
      .memori-context-expand-btn:hover {
        background: #d1d5db;
      }
      .memori-granola-refresh-bar {
        padding: 8px 12px;
        border-bottom: 1px solid #e5e7eb;
      }
      .memori-granola-refresh-btn {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #10a37f;
        border-radius: 6px;
        background: #ffffff;
        color: #10a37f;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
      }
      .memori-granola-refresh-btn:hover {
        background: #ecfdf5;
      }
      .memori-granola-refresh-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .memori-granola-item {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
        transition: box-shadow 0.2s;
      }
      .memori-granola-item:hover {
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      .memori-granola-title {
        font-weight: 600;
        color: #111827;
        font-size: 14px;
        margin-bottom: 6px;
      }
      .memori-granola-meta {
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 8px;
      }
      .memori-granola-actions {
        display: flex;
        gap: 8px;
      }
      .memori-granola-inject-btn {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 500;
        background: #10a37f;
        color: white;
        font-family: inherit;
      }
      .memori-granola-inject-btn:hover {
        background: #0d8c6d;
      }
      .memori-granola-connect-btn {
        padding: 10px 20px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        background: #10a37f;
        color: white;
        font-family: inherit;
        width: 100%;
      }
      .memori-granola-connect-btn:hover {
        background: #0d8c6d;
      }
      .memori-granola-loading {
        padding: 40px 20px;
        text-align: center;
        color: #6b7280;
        font-size: 14px;
      }
      .memori-granola-notes {
        font-size: 13px;
        color: #374151;
        line-height: 1.5;
        margin-top: 8px;
        white-space: pre-wrap;
        word-wrap: break-word;
        max-height: 120px;
        overflow: hidden;
        transition: max-height 0.3s ease;
      }
      .memori-granola-notes.expanded {
        max-height: none;
      }
      .memori-granola-see-more {
        background: none;
        border: none;
        color: #10a37f;
        font-size: 12px;
        cursor: pointer;
        padding: 4px 0;
        font-family: inherit;
      }
      .memori-granola-see-more:hover {
        text-decoration: underline;
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(sidebar);
  sidebarContainer = sidebar;
  console.log('[Memori] Sidebar appended to body, element:', sidebar);
  console.log('[Memori] Sidebar position:', window.getComputedStyle(sidebar).right);
  
  // Close button handler
  const closeBtn = sidebar.querySelector('#memori-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      toggleSidebar();
    });
  }
  
  // Auto-capture toggle handler
  const toggle = sidebar.querySelector('#memori-auto-capture-toggle');
  if (toggle) {
    // Load current setting
    chrome.runtime.sendMessage({ action: 'getSettings' }).then(settings => {
      if (settings) {
        toggle.checked = settings.autoCapture || false;
        autoCaptureEnabled = toggle.checked;
        if (autoCaptureEnabled) {
          setupAutoCapture();
        }
      }
    }).catch(error => {
      console.error('[Memori] Error loading settings:', error);
      toggle.checked = false;
      autoCaptureEnabled = false;
    });
    
    toggle.addEventListener('change', async (e) => {
      autoCaptureEnabled = e.target.checked;
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'saveSettings',
          settings: { autoCapture: autoCaptureEnabled }
        });
        
        if (response && response.success) {
          console.log('[Memori] Auto-capture', autoCaptureEnabled ? 'enabled' : 'disabled');
          if (autoCaptureEnabled) {
            setupAutoCapture();
          }
        } else {
          console.warn('[Memori] Failed to save settings, but continuing anyway');
          // Continue even if save failed
          if (autoCaptureEnabled) {
            setupAutoCapture();
          }
        }
      } catch (error) {
        console.error('[Memori] Error saving settings:', error);
        // Continue even if there's an error
        if (autoCaptureEnabled) {
          setupAutoCapture();
        }
      }
    });
  }

  // Tab switching
  const tabBtns = sidebar.querySelectorAll('.memori-tab-btn');
  const memoriesPanel = sidebar.querySelector('#memori-memories-panel');
  const contextsPanel = sidebar.querySelector('#memori-contexts-panel');
  const granolaPanel = sidebar.querySelector('#memori-granola-list');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      memoriesPanel.style.display = tab === 'memories' ? '' : 'none';
      contextsPanel.style.display = tab === 'contexts' ? '' : 'none';
      granolaPanel.style.display = tab === 'granola' ? '' : 'none';
      if (tab === 'memories') loadMemoriesIntoSidebar();
      else if (tab === 'contexts') loadContextHandoffsIntoSidebar();
      else loadGranolaRecordings();
    });
  });

  // OpenAI API key settings
  const openaiInput = sidebar.querySelector('#memori-openai-key-input');
  const openaiSave = sidebar.querySelector('#memori-openai-key-save');
  const openaiStatus = sidebar.querySelector('#memori-openai-key-status');
  if (openaiInput && openaiSave) {
    chrome.runtime.sendMessage({ action: 'getOpenAIApiKey' }).then(r => {
      if (r?.key) {
        openaiInput.placeholder = '••••••••••••';
        openaiStatus.textContent = 'API key configured ✓';
      }
    }).catch(() => {});
    openaiSave.addEventListener('click', async () => {
      const key = openaiInput.value?.trim();
      if (!key) {
        openaiStatus.textContent = 'Enter a key first';
        return;
      }
      await chrome.runtime.sendMessage({ action: 'saveOpenAIApiKey', key });
      openaiInput.value = '';
      openaiInput.placeholder = '••••••••••••';
      openaiStatus.textContent = 'API key configured ✓';
    });
  }
  
  return sidebar;
}

// Render Granola meetings into container (shared helper)
function renderGranolaMeetingsList(meetings, container) {
  const COLLAPSE_LENGTH = 200;
  container.innerHTML = meetings.map((meeting, idx) => {
    const id = meeting.id || meeting.meeting_id || meeting.meetingId || String(idx);
    const title = meeting.title || meeting.name || meeting.subject || 'Untitled Meeting';
    const date = meeting.date || meeting.meeting_date || meeting.created_at || meeting.start_time || '';
    const attendees = meeting.attendees || meeting.participants || [];
    const attendeesStr = Array.isArray(attendees) ? attendees.join(', ') : (attendees || '');
    const dateStr = date ? (typeof date === 'string' ? formatGranolaDate(date) : formatGranolaDate(new Date(date).toISOString())) : '';
    const notes = meeting.notes || meeting.content || meeting.raw || meeting.summary_text || meeting.summary_markdown || '';
    const notesDisplay = String(notes).trim();
    const isLong = notesDisplay.length > COLLAPSE_LENGTH;
    const shortNotes = isLong ? notesDisplay.substring(0, COLLAPSE_LENGTH) + '...' : notesDisplay;
    return `
      <div class="memori-granola-item" data-meeting-id="${escapeHtml(id)}" data-meeting-index="${idx}">
        <div class="memori-granola-title">${escapeHtml(title)}</div>
        <div class="memori-granola-meta">
          ${dateStr ? `<span>${dateStr}</span>` : ''}
          ${attendeesStr ? `<br><span>${escapeHtml(attendeesStr)}</span>` : ''}
        </div>
        ${notesDisplay ? `
          <div class="memori-granola-notes">${escapeHtml(shortNotes)}</div>
          ${isLong ? '<button class="memori-granola-see-more" type="button">See more</button>' : ''}
        ` : ''}
        <div class="memori-granola-actions">
          <button class="memori-granola-inject-btn" data-meeting-id="${escapeHtml(id)}" data-meeting-index="${idx}">Inject</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.memori-granola-see-more').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.memori-granola-item');
      const notesEl = item?.querySelector('.memori-granola-notes');
      if (!notesEl) return;
      const idx = parseInt(item?.getAttribute('data-meeting-index') || '0', 10);
      const meeting = meetings[idx];
      const fullNotes = meeting?.notes || meeting?.content || meeting?.raw || meeting?.summary_text || meeting?.summary_markdown || '';
      const isExpanded = notesEl.classList.contains('expanded');
      if (isExpanded) {
        const short = fullNotes.length > COLLAPSE_LENGTH ? fullNotes.substring(0, COLLAPSE_LENGTH) + '...' : fullNotes;
        notesEl.textContent = short;
        notesEl.classList.remove('expanded');
        btn.textContent = 'See more';
      } else {
        notesEl.textContent = fullNotes;
        notesEl.classList.add('expanded');
        btn.textContent = 'See less';
      }
    });
  });

  container.querySelectorAll('.memori-granola-inject-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.memori-granola-item');
      const idx = parseInt(item?.getAttribute('data-meeting-index') || '0', 10);
      const meeting = meetings[idx];
      let textToInject = meeting?.notes || meeting?.content || meeting?.raw || meeting?.summary_text || meeting?.summary_markdown || '';
      if (!textToInject) {
        const meetingId = e.target.getAttribute('data-meeting-id');
        const result = await chrome.runtime.sendMessage({ action: 'granolaGetMeetingDetails', meetingId });
        if (result.error) {
          alert('Could not load meeting: ' + result.error);
          return;
        }
        textToInject = result.meeting || '';
      }
      if (textToInject) {
        await injectMemory(textToInject, null);
        btn.textContent = 'Injected!';
        btn.style.background = '#059669';
        setTimeout(() => {
          btn.textContent = 'Inject';
          btn.style.background = '';
        }, 1000);
      }
    });
  });
}

// Load Granola recordings: use cache first, auto-fetch if empty
async function loadGranolaRecordings() {
  if (!sidebarContainer) return;
  const listContainer = sidebarContainer.querySelector('#memori-granola-list');
  if (!listContainer) return;

  try {
    const authResult = await chrome.runtime.sendMessage({ action: 'granolaCheckAuth' });

    if (!authResult.authenticated) {
      listContainer.innerHTML = `
        <div class="memori-empty">
          <p style="margin-bottom: 16px;">Connect your Granola account to view meeting recordings.</p>
          <button class="memori-granola-connect-btn" id="memori-granola-connect">Connect to Granola</button>
        </div>
      `;
      const connectBtn = listContainer.querySelector('#memori-granola-connect');
      if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
          connectBtn.disabled = true;
          connectBtn.textContent = 'Connecting...';
          const result = await chrome.runtime.sendMessage({ action: 'granolaAuthenticate' });
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect to Granola';
          if (result.success) {
            loadGranolaRecordings();
          } else {
            listContainer.innerHTML = `
              <div class="memori-error">
                <p>${escapeHtml(result.error || 'Authentication failed')}</p>
                <button class="memori-granola-connect-btn" id="memori-granola-retry" style="margin-top: 12px;">Retry</button>
              </div>
            `;
            listContainer.querySelector('#memori-granola-retry')?.addEventListener('click', () => loadGranolaRecordings());
          }
        });
      }
      return;
    }

    // Try cache first (no API call)
    const { meetings: cachedMeetings, cachedAt } = await chrome.runtime.sendMessage({ action: 'getGranolaMeetingsCached' });

    if (cachedMeetings && cachedMeetings.length > 0) {
      // Show cached data immediately with Refresh button
      listContainer.innerHTML = `
        <div class="memori-granola-refresh-bar">
          <button id="memori-granola-refresh-btn" class="memori-granola-refresh-btn">Refresh</button>
        </div>
        <div id="memori-granola-items"></div>
      `;
      const itemsEl = listContainer.querySelector('#memori-granola-items');
      renderGranolaMeetingsList(cachedMeetings, itemsEl);
      listContainer.querySelector('#memori-granola-refresh-btn')?.addEventListener('click', () => refreshGranolaRecordings());
      return;
    }

    // Cache empty: auto-fetch (same as old behavior)
    listContainer.innerHTML = '<div class="memori-granola-loading">Loading...</div>';
    const { meetings, error } = await chrome.runtime.sendMessage({ action: 'granolaFetchAndCacheMeetings' });

    if (error) {
      listContainer.innerHTML = `
        <div class="memori-error">
          <p>${escapeHtml(error)}</p>
          <button class="memori-granola-connect-btn" id="memori-granola-reconnect" style="margin-top: 12px;">Reconnect</button>
        </div>
      `;
      listContainer.querySelector('#memori-granola-reconnect')?.addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ action: 'granolaAuthenticate' });
        if (result.success) {
          loadGranolaRecordings();
        } else {
          listContainer.querySelector('p').textContent = result.error || 'Reconnection failed';
        }
      });
      return;
    }

    if (!meetings || meetings.length === 0) {
      listContainer.innerHTML = `
        <div class="memori-granola-refresh-bar">
          <button id="memori-granola-refresh-btn" class="memori-granola-refresh-btn">Refresh</button>
        </div>
        <div class="memori-empty">No recordings found.</div>
      `;
      listContainer.querySelector('#memori-granola-refresh-btn')?.addEventListener('click', () => refreshGranolaRecordings());
      return;
    }
    
    // Success: render with Refresh button
    listContainer.innerHTML = `
      <div class="memori-granola-refresh-bar">
        <button id="memori-granola-refresh-btn" class="memori-granola-refresh-btn">Refresh</button>
      </div>
      <div id="memori-granola-items"></div>
    `;
    const itemsEl = listContainer.querySelector('#memori-granola-items');
    renderGranolaMeetingsList(meetings, itemsEl);
    listContainer.querySelector('#memori-granola-refresh-btn')?.addEventListener('click', () => refreshGranolaRecordings());
    
  } catch (err) {
    console.error('[Memori] Error loading Granola recordings:', err);
    listContainer.innerHTML = '<div class="memori-error">Error loading recordings</div>';
  }
}

// Manual refresh: fetch from Granola API and update display
async function refreshGranolaRecordings() {
  if (!sidebarContainer) return;
  const listContainer = sidebarContainer.querySelector('#memori-granola-list');
  const refreshBtn = listContainer?.querySelector('#memori-granola-refresh-btn');
  if (!listContainer) return;

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Fetching...';
  }
  listContainer.innerHTML = '<div class="memori-granola-loading">Fetching from Granola...</div>';

  try {
    const authResult = await chrome.runtime.sendMessage({ action: 'granolaCheckAuth' });
    if (!authResult.authenticated) {
      listContainer.innerHTML = `
        <div class="memori-empty">
          <p style="margin-bottom: 16px;">Connect your Granola account first.</p>
          <button class="memori-granola-connect-btn" id="memori-granola-connect">Connect to Granola</button>
        </div>
      `;
      listContainer.querySelector('#memori-granola-connect')?.addEventListener('click', () => loadGranolaRecordings());
      return;
    }

    const { meetings, error } = await chrome.runtime.sendMessage({ action: 'granolaFetchAndCacheMeetings' });

    if (error) {
      listContainer.innerHTML = `
        <div class="memori-error">
          <p>${escapeHtml(error)}</p>
          <button class="memori-granola-connect-btn" id="memori-granola-reconnect" style="margin-top: 12px;">Reconnect</button>
        </div>
      `;
      listContainer.querySelector('#memori-granola-reconnect')?.addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ action: 'granolaAuthenticate' });
        if (result.success) refreshGranolaRecordings();
      });
    } else if (!meetings || meetings.length === 0) {
      listContainer.innerHTML = `
        <div class="memori-granola-refresh-bar">
          <button id="memori-granola-refresh-btn" class="memori-granola-refresh-btn">Refresh</button>
        </div>
        <div class="memori-empty">No recordings found.</div>
      `;
      listContainer.querySelector('#memori-granola-refresh-btn')?.addEventListener('click', () => refreshGranolaRecordings());
    } else {
      listContainer.innerHTML = `
        <div class="memori-granola-refresh-bar">
          <button id="memori-granola-refresh-btn" class="memori-granola-refresh-btn">Refresh</button>
        </div>
        <div id="memori-granola-items"></div>
      `;
      const itemsEl = listContainer.querySelector('#memori-granola-items');
      renderGranolaMeetingsList(meetings, itemsEl);
      listContainer.querySelector('#memori-granola-refresh-btn')?.addEventListener('click', () => refreshGranolaRecordings());
    }
  } catch (err) {
    console.error('[Memori] Error refreshing Granola:', err);
    listContainer.innerHTML = '<div class="memori-error">Error fetching recordings</div>';
  }
}

function formatGranolaDate(dateStr) {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    if (diff < 86400000) return 'Today';
    if (diff < 172800000) return 'Yesterday';
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} days ago`;
    return date.toLocaleDateString();
  } catch (_) {
    return dateStr;
  }
}

// ========== Context Export ==========

function inferMessageRole(el) {
  if (!el) return null;
  const attrRole = (el.getAttribute('data-message-author-role') || '').toLowerCase();
  if (attrRole === 'user' || attrRole === 'assistant') return attrRole;

  const haystack = [
    el.getAttribute('data-testid') || '',
    el.getAttribute('aria-label') || '',
    el.className || '',
    el.id || ''
  ].join(' ').toLowerCase();

  if (/(^|[\s_-])(user|human|query|prompt)([\s_-]|$)/.test(haystack)) return 'user';
  if (/(^|[\s_-])(assistant|claude|model|ai|gemini|bard|response)([\s_-]|$)/.test(haystack)) return 'assistant';
  return null;
}

// Extract full conversation from ChatGPT DOM (for smart compression)
function extractFullConversation() {
  const messages = [];
  const seen = new Set();
  const candidates = [];
  const selectors = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-testid*="user-message"]',
    '[data-testid*="assistant-message"]',
    '[data-testid*="message"]',
    '[data-testid*="chat-turn"]',
    '[class*="user-query"]',
    '[class*="model-response"]',
    '[class*="response-content"]',
    'article',
    'div[class*="message"]'
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach(el => {
      if (!isElementVisible(el)) return;
      const container = el.closest(
        '[data-message-author-role],[data-testid*="message"],[data-testid*="chat-turn"],[class*="user-query"],[class*="model-response"],[class*="response-content"],article,div[class*="message"]'
      ) || el;
      const role = inferMessageRole(container) || inferMessageRole(el);
      candidates.push({ el: container, role });
    });
  }

  candidates.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  let lastResolvedRole = null;
  for (const { el, role } of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    let text = (el.innerText || el.textContent || '').trim();
    el.querySelectorAll('button').forEach(btn => {
      const btnText = btn.innerText || btn.textContent || '';
      if (btnText) text = text.replace(btnText, '').trim();
    });
    text = text.replace(/Copy code|Regenerate|Thumbs up|Thumbs down/gi, '').trim();
    if (!text) continue;

    // Fallback for UIs where role is not explicit (common in Claude DOM updates).
    let resolvedRole = role;
    if (!resolvedRole) {
      resolvedRole = lastResolvedRole === 'user' ? 'assistant' : 'user';
    }
    lastResolvedRole = resolvedRole;
    messages.push({ role: resolvedRole, content: text });
  }
  return messages;
}

// Alias for legacy export (chat_export)
function extractChatContext() {
  return extractFullConversation();
}

// Format messages into compact portable form
function formatContextCompact(messages) {
  return messages.map(m => {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    return `${label}: ${m.content}`;
  }).join('\n\n');
}

// Export chat context and save as memory (type: chat_export)
async function exportChatContext() {
  const messages = extractChatContext();
  if (messages.length === 0) {
    return { success: false, error: 'No messages found in this chat' };
  }
  const compactText = formatContextCompact(messages);
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveMemory',
      text: compactText,
      type: 'chat_export',
      messageCount: messages.length
    });
    if (response && response.success) {
      return { success: true, messageCount: messages.length };
    }
    return { success: false, error: response?.error || 'Failed to save' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Load memories and display in sidebar
async function loadMemoriesIntoSidebar() {
  if (!sidebarContainer) return;
  
  const listContainer = sidebarContainer.querySelector('#memori-memories-list');
  if (!listContainer) return;
  
  try {
    const memories = await chrome.runtime.sendMessage({ action: 'getMemories' });
    
    if (memories.length === 0) {
      listContainer.innerHTML = '<div class="memori-empty">No memories yet. Save something to get started!</div>';
      return;
    }
    
    listContainer.innerHTML = memories.map(memory => {
      const isChatExport = memory.type === 'chat_export';
      const isAssistant = memory.type === 'assistant';
      const typeLabel = isChatExport
        ? `💬 Chat export${memory.messageCount ? ` (${memory.messageCount} msgs)` : ''}`
        : (isAssistant ? '🤖 Assistant' : '👤 You');
      const typeClass = isChatExport ? 'memori-chat-export' : (isAssistant ? 'memori-assistant' : 'memori-user');
      
      return `
      <div class="memori-memory-item ${typeClass}" data-id="${memory.id}">
        <div class="memori-memory-header">
          <span class="memori-memory-type">${typeLabel}</span>
          <span class="memori-memory-time">${formatTime(memory.timestamp)}</span>
        </div>
        <div class="memori-memory-text">${escapeHtml(memory.text)}</div>
        <div class="memori-memory-actions">
          <button class="memori-inject-btn" data-id="${memory.id}">Inject</button>
          <button class="memori-delete-btn" data-id="${memory.id}">Delete</button>
        </div>
      </div>
    `;
    }).join('');
    
    // Attach event listeners
    listContainer.querySelectorAll('.memori-inject-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const memoryId = e.target.getAttribute('data-id');
        const memory = memories.find(m => m.id === memoryId);
        if (memory) {
          await injectMemory(memory.text, memoryId);
        }
      });
    });
    
    listContainer.querySelectorAll('.memori-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const memoryId = e.target.getAttribute('data-id');
        const response = await chrome.runtime.sendMessage({
          action: 'deleteMemory',
          memoryId: memoryId
        });
        if (response.success) {
          loadMemoriesIntoSidebar();
        }
      });
    });
    
  } catch (error) {
    console.error('Error loading memories:', error);
    listContainer.innerHTML = '<div class="memori-error">Error loading memories</div>';
  }
}

// Load context handoffs and display in sidebar
async function loadContextHandoffsIntoSidebar() {
  if (!sidebarContainer) return;
  const panel = sidebarContainer.querySelector('#memori-contexts-panel');
  if (!panel) return;
  try {
    const contexts = await chrome.runtime.sendMessage({ action: 'getContextHandoffs' });
    if (contexts.length === 0) {
      panel.innerHTML = '<div class="memori-empty" style="padding: 40px 20px; text-align: center; color: #6b7280;">No context handoffs yet. Use "📋 Export Context" to compress a conversation.</div>';
      return;
    }
    panel.innerHTML = contexts.map(ctx => `
      <div class="memori-context-item" data-id="${ctx.id}">
        <div class="memori-context-title">${escapeHtml(ctx.title || 'Context handoff')}</div>
        <div class="memori-context-meta">${formatTime(ctx.timestamp)} · ${ctx.messageCount || 0} messages</div>
        <div class="memori-context-preview">${escapeHtml((ctx.content || '').substring(0, 300))}${(ctx.content || '').length > 300 ? '...' : ''}</div>
        <div class="memori-memory-actions">
          <button class="memori-context-expand-btn" data-id="${ctx.id}">Expand</button>
          <button class="memori-inject-btn" data-id="${ctx.id}">Inject</button>
          <button class="memori-delete-btn memori-context-delete" data-id="${ctx.id}">Delete</button>
        </div>
      </div>
    `).join('');
    panel.style.padding = '12px';
    const contextData = contexts;
    panel.querySelectorAll('.memori-context-expand-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.memori-context-item');
        const ctx = contextData.find(c => c.id === item.dataset.id);
        if (ctx) {
          const preview = item.querySelector('.memori-context-preview');
          const isExpanded = item.classList.toggle('expanded');
          const truncated = (ctx.content || '').substring(0, 300) + ((ctx.content || '').length > 300 ? '...' : '');
          preview.textContent = isExpanded ? ctx.content : truncated;
          btn.textContent = isExpanded ? 'Collapse' : 'Expand';
        }
      });
    });
    panel.querySelectorAll('.memori-inject-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const ctx = contextData.find(c => c.id === e.target.getAttribute('data-id'));
        if (ctx) await injectMemory(ctx.content, ctx.id);
      });
    });
    panel.querySelectorAll('.memori-context-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        const res = await chrome.runtime.sendMessage({ action: 'deleteContextHandoff', contextId: id });
        if (res?.success) loadContextHandoffsIntoSidebar();
      });
    });
  } catch (err) {
    console.error('[Memori] Error loading context handoffs:', err);
    panel.innerHTML = '<div class="memori-error">Error loading context handoffs</div>';
  }
}

// Inject memory text into ChatGPT input
async function injectMemory(text, memoryId) {
  const input = findChatGPTInput();
  if (!input) {
    alert('Could not find ChatGPT input box');
    return;
  }
  
  // Focus the input
  input.focus();
  
  if (input.tagName === 'TEXTAREA') {
    // Append to textarea value
    const currentValue = input.value;
    const separator = currentValue ? '\n\n' : '';
    input.value = currentValue + separator + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (input.contentEditable === 'true') {
    // Append to contenteditable div
    const currentText = input.innerText || input.textContent;
    const separator = currentText ? '\n\n' : '';
    
    // Create text node and append
    const textNode = document.createTextNode(separator + text);
    input.appendChild(textNode);
    
    // Move cursor to end
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(input);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    
    // Trigger input event
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  
  // Visual feedback
  if (memoryId) {
    const injectBtn = document.querySelector(`.memori-inject-btn[data-id="${memoryId}"]`);
    if (injectBtn) {
      const originalText = injectBtn.textContent;
      injectBtn.textContent = '✓ Injected!';
      injectBtn.style.background = '#059669';
      setTimeout(() => {
        injectBtn.textContent = originalText;
        injectBtn.style.background = '';
      }, 1000);
    }
  }
}

// Toggle sidebar visibility
function toggleSidebar() {
  console.log('[Memori] Toggling sidebar, current state:', sidebarVisible);
  
  if (!sidebarContainer) {
    console.log('[Memori] Creating sidebar...');
    createSidebar();
  }
  
  sidebarVisible = !sidebarVisible;
  console.log('[Memori] Sidebar visible:', sidebarVisible);
  
  if (sidebarVisible) {
    sidebarContainer.classList.add('memori-sidebar-visible');
    // Force visibility with inline style as backup
    sidebarContainer.style.right = '0px';
    console.log('[Memori] Added visible class, sidebar element:', sidebarContainer);
    console.log('[Memori] Sidebar classes:', sidebarContainer.className);
    console.log('[Memori] Sidebar computed right:', window.getComputedStyle(sidebarContainer).right);
    loadMemoriesIntoSidebar();
  } else {
    sidebarContainer.classList.remove('memori-sidebar-visible');
    sidebarContainer.style.right = '-400px';
    console.log('[Memori] Removed visible class');
  }
}

// Utility: Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Utility: Format timestamp
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Memori] Received message:', request);
  if (request.action === 'toggleSidebar') {
    console.log('[Memori] Toggle sidebar requested');
    try {
      toggleSidebar();
      sendResponse({ success: true });
    } catch (error) {
      console.error('[Memori] Error toggling sidebar:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep channel open for async response
  }
  return false;
});

// Auto-save message when sent
async function autoCaptureMessage() {
  if (!autoCaptureEnabled) return;
  
  console.log('[Memori] Auto-capture triggered');
  
  // Try multiple times with small delays to catch text before it's cleared
  let text = '';
  let attempts = 0;
  const maxAttempts = 5;
  
  while (!text && attempts < maxAttempts) {
    const input = findChatGPTInput();
    if (input) {
      text = extractTextFromInput(input);
      console.log(`[Memori] Capture attempt ${attempts + 1}, text length:`, text.length);
      
      if (!text) {
        // Try alternative extraction methods for contenteditable
        if (input.contentEditable === 'true' || input.isContentEditable) {
          // Try getting text from all descendants
          const allText = input.innerText || input.textContent || '';
          if (allText.trim()) {
            text = allText.trim();
            console.log('[Memori] Found text via innerText/textContent:', text.length);
          }
          
          // Try getting from text nodes directly
          if (!text) {
            const range = document.createRange();
            range.selectNodeContents(input);
            const textFromRange = range.toString().trim();
            if (textFromRange) {
              text = textFromRange;
              console.log('[Memori] Found text via range:', text.length);
            }
          }
        }
      }
    }
    
    if (!text && attempts < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    attempts++;
  }
  
  if (!text) {
    console.warn('[Memori] Could not extract text for auto-capture');
    return;
  }
  
  console.log('[Memori] Auto-capturing message:', text.substring(0, 50));
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveMemory',
      text: text,
      type: 'user'
    });
    
    if (response && response.success) {
      console.log('[Memori] Auto-captured message saved');
      // Refresh sidebar if visible
      if (sidebarVisible) {
        loadMemoriesIntoSidebar();
      }
    } else {
      console.warn('[Memori] Failed to save auto-captured message');
    }
  } catch (error) {
    console.error('[Memori] Error auto-capturing message:', error);
  }
}

// Track captured assistant messages to avoid duplicates
let capturedAssistantIds = new Set();

// Find and extract ChatGPT assistant responses
function findAssistantResponse() {
  // Common selectors for ChatGPT assistant messages
  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    'div[class*="assistant"]',
    'div[class*="Assistant"]',
    'div:has([data-message-author-role="assistant"])'
  ];
  
  let assistantMessage = null;
  
  for (const selector of assistantSelectors) {
    try {
      const messages = document.querySelectorAll(selector);
      // Get the last (most recent) assistant message
      if (messages.length > 0) {
        assistantMessage = messages[messages.length - 1];
        break;
      }
    } catch (e) {
      // Invalid selector, continue
    }
  }
  
  // If no specific selector worked, try finding by structure
  if (!assistantMessage) {
    // Look for message containers and check for assistant indicators
    const messageContainers = document.querySelectorAll('[class*="message"], [class*="Message"]');
    for (const container of messageContainers) {
      const text = container.innerText || container.textContent || '';
      // Check if it looks like an assistant message (not user input)
      if (text && !container.querySelector('textarea') && !container.querySelector('[contenteditable="true"]')) {
        // Check if it's not a user message
        const isUser = container.querySelector('[data-message-author-role="user"]') ||
                       container.getAttribute('data-message-author-role') === 'user';
        if (!isUser && text.length > 10) {
          assistantMessage = container;
          break;
        }
      }
    }
  }
  
  return assistantMessage;
}

// Extract text from assistant response - get ALL text, no limits
function extractAssistantText(assistantElement) {
  if (!assistantElement) return '';
  
  // Get ALL text from the entire assistant message element
  // Use innerText to get visible text (ignores hidden elements)
  let text = assistantElement.innerText || assistantElement.textContent || '';
  
  // If innerText is empty or too short, try getting from all text nodes
  if (!text || text.length < 50) {
    // Use Range API to get all text content
    try {
      const range = document.createRange();
      range.selectNodeContents(assistantElement);
      text = range.toString();
    } catch (e) {
      // Range failed, use textContent as fallback
      text = assistantElement.textContent || '';
    }
  }
  
  // Clean up: remove button text and other UI elements
  const buttons = assistantElement.querySelectorAll('button');
  buttons.forEach(btn => {
    const btnText = btn.innerText || btn.textContent || '';
    if (btnText) {
      text = text.replace(btnText, '').trim();
    }
  });
  
  // Remove common UI text patterns
  text = text.replace(/Copy code|Regenerate|Thumbs up|Thumbs down/gi, '').trim();
  
  // Return full text - no character limit
  return text.trim();
}

// Auto-capture assistant response
async function autoCaptureAssistantResponse() {
  if (!autoCaptureEnabled) return;
  
  console.log('[Memori] Checking for assistant response...');
  
  // Wait longer for the response to fully render (especially for long responses)
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Try multiple times to catch the full response as it streams in
  let assistantElement = null;
  let lastTextLength = 0;
  let stableCount = 0;
  
  for (let attempt = 0; attempt < 5; attempt++) {
    assistantElement = findAssistantResponse();
    if (assistantElement) {
      const currentText = extractAssistantText(assistantElement);
      const currentLength = currentText.length;
      
      console.log(`[Memori] Attempt ${attempt + 1}, text length: ${currentLength}`);
      
      // If text length is stable (not growing), we've captured the full response
      if (currentLength === lastTextLength && currentLength > 0) {
        stableCount++;
        if (stableCount >= 2) {
          console.log('[Memori] Response appears complete');
          break;
        }
      } else {
        stableCount = 0;
      }
      
      lastTextLength = currentLength;
    }
    
    // Wait a bit before checking again
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  if (!assistantElement) {
    console.log('[Memori] No assistant response found');
    return;
  }
  
  // Generate a unique ID for this message to avoid duplicates
  const fullText = extractAssistantText(assistantElement);
  const messageId = assistantElement.getAttribute('data-message-id') || 
                   assistantElement.id || 
                   (fullText ? fullText.substring(0, 100) : 'unknown');
  
  if (capturedAssistantIds.has(messageId)) {
    console.log('[Memori] Assistant response already captured');
    return;
  }
  
  const text = extractAssistantText(assistantElement);
  if (!text || text.length < 10) {
    console.log('[Memori] Assistant response text too short or empty');
    return;
  }
  
  console.log('[Memori] Auto-capturing assistant response:', text.length, 'characters, preview:', text.substring(0, 100));
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveMemory',
      text: text,
      type: 'assistant'
    });
    
    if (response && response.success) {
      capturedAssistantIds.add(messageId);
      console.log('[Memori] Auto-captured assistant response saved');
      // Refresh sidebar if visible
      if (sidebarVisible) {
        loadMemoriesIntoSidebar();
      }
    }
  } catch (error) {
    console.error('[Memori] Error auto-capturing assistant response:', error);
  }
}

// Setup auto-capture listeners
function setupAutoCapture() {
  // Listen for form submissions
  document.addEventListener('submit', (e) => {
    console.log('[Memori] Form submitted, auto-capturing...');
    // Capture immediately, before form clears
    autoCaptureMessage();
  }, true);
  
  // Listen for Enter key in input (ChatGPT sends on Enter)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const input = findChatGPTInput();
      if (input && (document.activeElement === input || input.contains(document.activeElement))) {
        console.log('[Memori] Enter pressed in input, auto-capturing...');
        // Capture immediately before Enter clears the input
        autoCaptureMessage();
      }
    }
  }, true);
  
  // Listen for send button clicks - capture on mousedown to get text before click clears it
  const observeSendButtons = () => {
    SEND_BUTTON_SELECTORS.forEach(selector => {
      try {
        const buttons = document.querySelectorAll(selector);
        buttons.forEach(button => {
          if (!button.dataset.memoriListener) {
            button.dataset.memoriListener = 'true';
            // Use mousedown instead of click to capture before text is cleared
            button.addEventListener('mousedown', (e) => {
              console.log('[Memori] Send button mousedown, auto-capturing...');
              // Capture immediately
              autoCaptureMessage();
            }, true);
            // Also listen to click as backup
            button.addEventListener('click', (e) => {
              console.log('[Memori] Send button clicked (backup), auto-capturing...');
              autoCaptureMessage();
            }, true);
          }
        });
      } catch (e) {
        // Selector might not be valid, skip
      }
    });
    injectMSendButtonNearSend();
  };
  
  // Initial check
  observeSendButtons();
  
  // Watch for new send buttons (ChatGPT dynamically creates them)
  const observer = new MutationObserver(() => {
    observeSendButtons();
    
    // Also watch for new assistant responses
    // Check if a new assistant message appeared
    const assistantElement = findAssistantResponse();
    if (assistantElement) {
      const messageId = assistantElement.getAttribute('data-message-id') || 
                       assistantElement.id || 
                       assistantElement.innerText.substring(0, 50);
      if (!capturedAssistantIds.has(messageId)) {
        // Wait a bit for the response to finish rendering
        setTimeout(() => {
          autoCaptureAssistantResponse();
        }, 2000);
      }
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Track when user sends a message to trigger assistant capture
  let userMessageSent = false;
  
  // Wrap the original autoCaptureMessage to also trigger assistant capture
  const originalAutoCaptureMessage = window.memoriOriginalAutoCapture || autoCaptureMessage;
  window.memoriOriginalAutoCapture = originalAutoCaptureMessage;
  
  // Override autoCaptureMessage to also capture assistant response
  window.autoCaptureMessage = async function() {
    await originalAutoCaptureMessage();
    userMessageSent = true;
    // After user message is captured, wait for assistant response
    setTimeout(() => {
      autoCaptureAssistantResponse();
    }, 3000); // Wait 3 seconds for response to start appearing
  };
  
  console.log('[Memori] Auto-capture listeners set up (user + assistant)');
}

// Load settings and setup auto-capture
async function loadSettings() {
  try {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (settings) {
      autoCaptureEnabled = settings.autoCapture || false;
      console.log('[Memori] Auto-capture enabled:', autoCaptureEnabled);
      
      if (autoCaptureEnabled) {
        setupAutoCapture();
      }
    } else {
      autoCaptureEnabled = false;
      console.log('[Memori] No settings found, auto-capture disabled');
    }
  } catch (error) {
    console.error('[Memori] Error loading settings:', error);
    autoCaptureEnabled = false;
  }
}

// Initialize: Inject save button when page loads
function initialize() {
  console.log('[Memori] Content script initialized');
  console.log('[Memori] Available input selectors:', INPUT_SELECTORS.length);
  
  // Load settings
  loadSettings();
  
  // Always inject button container immediately (fixed position, doesn't need input)
  if (!document.getElementById('memori-button-container')) {
    console.log('[Memori] Injecting button container immediately');
    const container = createMemoriButtonContainer();
    saveButton = container.querySelector('#memori-save-btn');
    document.body.appendChild(container);
    console.log('[Memori] Buttons injected at', new Date().toISOString());
  }
  injectMSendButtonNearSend();
  
  // Wait for ChatGPT to load and find input
  let attempts = 0;
  const maxAttempts = 40; // 20 seconds total
  
  const checkInterval = setInterval(() => {
    attempts++;
    const input = findChatGPTInput();
    if (input) {
      clearInterval(checkInterval);
      console.log('[Memori] Input found after', attempts, 'attempts:', input.tagName, input.id || input.className);
      
      // Ensure button container exists
      if (!document.getElementById('memori-button-container')) {
        console.log('[Memori] Re-injecting buttons after input found');
        injectSaveButton();
      }
      injectMSendButtonNearSend();
      
      // Setup auto-capture if enabled
      if (autoCaptureEnabled) {
        setupAutoCapture();
      }
      
      // Re-inject if input changes (ChatGPT may dynamically update DOM)
      const observer = new MutationObserver(() => {
        if (!document.getElementById('memori-button-container')) {
          const newInput = findChatGPTInput();
          if (newInput) {
            console.log('[Memori] Re-injecting buttons after DOM change');
            injectSaveButton();
          }
        }
        injectMSendButtonNearSend();
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    } else if (attempts >= maxAttempts) {
      clearInterval(checkInterval);
      console.warn('[Memori] Could not find ChatGPT input after', attempts, 'attempts');
      console.log('[Memori] Tried selectors:', INPUT_SELECTORS);
      // Button should already be injected above
    }
  }, 500);
}

// Expose debug function to window for manual testing
window.memoriDebug = function() {
  console.log('=== Memori Debug Info ===');
  console.log('URL:', window.location.href);
  console.log('Button exists:', !!document.getElementById('memori-save-btn'));
  console.log('Sidebar exists:', !!document.getElementById('memori-sidebar'));
  console.log('Sidebar visible:', sidebarVisible);
  console.log('Input found:', !!findChatGPTInput());
  console.log('Input element:', findChatGPTInput());
  console.log('All textareas:', document.querySelectorAll('textarea').length);
  console.log('All contenteditable:', document.querySelectorAll('[contenteditable="true"]').length);
  
  // Try to find input with each selector
  INPUT_SELECTORS.forEach(selector => {
    const el = document.querySelector(selector);
    if (el) {
      console.log('✓ Found with selector:', selector, el);
    }
  });
  
  // Force inject button container
  if (!document.getElementById('memori-button-container')) {
    console.log('Force injecting buttons...');
    const container = createMemoriButtonContainer();
    saveButton = container.querySelector('#memori-save-btn');
    document.body.appendChild(container);
  }
  
  // Force create and show sidebar
  if (!document.getElementById('memori-sidebar')) {
    console.log('Force creating sidebar...');
    createSidebar();
  }
  console.log('Force toggling sidebar...');
  sidebarVisible = false; // Reset state
  toggleSidebar();
  
  const sidebar = document.getElementById('memori-sidebar');
  if (sidebar) {
    console.log('Sidebar element:', sidebar);
    console.log('Sidebar classes:', sidebar.className);
    console.log('Sidebar computed style right:', window.getComputedStyle(sidebar).right);
    console.log('Sidebar computed style display:', window.getComputedStyle(sidebar).display);
    console.log('Sidebar computed style z-index:', window.getComputedStyle(sidebar).zIndex);
  }
  
  return {
    button: document.getElementById('memori-save-btn'),
    input: findChatGPTInput(),
    sidebar: document.getElementById('memori-sidebar'),
    sidebarVisible: sidebarVisible
  };
};

// Expose manual toggle function
window.memoriToggleSidebar = function() {
  console.log('[Memori] Manual toggle called');
  toggleSidebar();
};

// Start initialization
console.log('[Memori] Document ready state:', document.readyState);
console.log('[Memori] Current URL:', window.location.href);

if (document.readyState === 'loading') {
  console.log('[Memori] Waiting for DOMContentLoaded');
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[Memori] DOMContentLoaded fired');
    initialize();
  });
} else {
  console.log('[Memori] DOM already ready, initializing immediately');
  initialize();
}

// Also try after a short delay to catch late-loading pages
setTimeout(() => {
  if (!document.getElementById('memori-button-container')) {
    console.log('[Memori] Delayed initialization attempt');
    initialize();
  }
}, 2000);
