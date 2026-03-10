// Background Service Worker for Memori Extension
// Handles memory storage and retrieval using chrome.storage.local

const MAX_MEMORIES = 50;
const GRANOLA_TOKEN_KEY = 'granola_access_token';
const GRANOLA_REFRESH_KEY = 'granola_refresh_token';
const GRANOLA_TOKEN_EXPIRY_KEY = 'granola_token_expiry';
const GRANOLA_MEETINGS_CACHE_KEY = 'memori_granola_meetings_cache';
const MCP_ENDPOINT = 'https://mcp.granola.ai/mcp';
const STORAGE_KEY = 'memori_memories';
const SETTINGS_KEY = 'memori_settings';
const CONTEXTS_KEY = 'memori_contexts';
const OPENAI_API_KEY_KEY = 'openai_api_key';
const MAX_CHAT_EXPORTS = 10;
const MAX_CONTEXT_HANDOFFS = 10;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// Generate a simple UUID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Save a memory to storage (FIFO - keep last 50)
async function saveMemory(text, type = 'user', messageCount = null) {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    let memories = result[STORAGE_KEY] || [];
    
    // Create new memory object
    const newMemory = {
      id: generateId(),
      text: text.trim(),
      timestamp: Date.now(),
      type: type // 'user', 'assistant', or 'chat_export'
    };
    if (messageCount != null) newMemory.messageCount = messageCount;
    
    // Add to beginning of array
    memories.unshift(newMemory);
    
    // For chat_export type: keep only last MAX_CHAT_EXPORTS
    if (type === 'chat_export') {
      const chatExports = memories.filter(m => m.type === 'chat_export');
      if (chatExports.length > MAX_CHAT_EXPORTS) {
        const toRemove = chatExports.slice(MAX_CHAT_EXPORTS).map(m => m.id);
        memories = memories.filter(m => !toRemove.includes(m.id));
      }
    }
    
    // Keep only last MAX_MEMORIES entries overall
    if (memories.length > MAX_MEMORIES) {
      memories = memories.slice(0, MAX_MEMORIES);
    }
    
    // Save back to storage
    await chrome.storage.local.set({ [STORAGE_KEY]: memories });
    
    return { success: true, memory: newMemory, messageCount: newMemory.messageCount ?? null };
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

// Get settings from storage
async function getSettings() {
  try {
    const result = await chrome.storage.local.get([SETTINGS_KEY]);
    return result[SETTINGS_KEY] || {};
  } catch (error) {
    console.error('Error getting settings:', error);
    return {};
  }
}

// Save settings to storage
async function saveSettings(settings) {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return { success: true };
  } catch (error) {
    console.error('Error saving settings:', error);
    return { success: false, error: error.message };
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

// ========== Smart Context Compression (OpenAI) ==========

function parseOpenAIResponse(data) {
  if (data.error) {
    throw new Error(data.error.message || 'OpenAI API error');
  }
  const choice = data.choices?.[0];
  if (choice?.message?.content) {
    return choice.message.content.trim();
  }
  throw new Error('Unexpected OpenAI response format');
}

function extractProjectTitleFromCompression(compressedMarkdown) {
  const match = compressedMarkdown.match(/### PROJECT\s*\n\[?([^\]]+)\]?|### PROJECT\s*\n(.+?)(?=\n###|$)/s);
  if (match) {
    const title = (match[1] || match[2] || '').trim();
    return title.length > 80 ? title.substring(0, 77) + '...' : title;
  }
  return 'Context handoff';
}

async function compressContext(conversationArray, apiKey) {
  const formattedTranscript = conversationArray.map(m => {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    return `${label}: ${m.content}`;
  }).join('\n\n');
  const timestamp = new Date().toISOString();
  const compressionPrompt = `You are a context compression assistant. Given the following conversation transcript, extract and compress it into a structured handoff format that another LLM can use to seamlessly continue the conversation.

<conversation>
${formattedTranscript}
</conversation>

Output the following structure in markdown. Be concise but preserve critical information. Omit sections if not applicable.

## CONTEXT HANDOFF
Generated: ${timestamp}

### PROJECT
[1-2 sentences: core topic/goal of this conversation]

### USER PROFILE  
- Communication style: [observed preferences - brief/detailed, technical level, tone]
- Explicit instructions: [any direct requests about how to respond]

### KEY DECISIONS
[Bullet list of conclusions reached, choices made, things agreed upon]

### CURRENT STATE
[What was actively being worked on when conversation paused. Be specific.]

### NEXT STEPS
[What should happen next based on conversation flow]

### OPEN QUESTIONS
[Unresolved items, pending decisions, things user seemed uncertain about]

### CRITICAL CONTEXT
[Facts, constraints, or details that would be lost without explicit capture - project names, technical specs, deadlines, preferences expressed, etc.]

---
Compress now. Prioritize information density over completeness.`;

  const makeRequest = () => fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: compressionPrompt }],
      max_tokens: 1500,
      temperature: 0.3
    })
  });

  let response = await makeRequest();
  let data = await response.json();

  // Retry once after 15s on rate limit
  if (response.status === 429) {
    await new Promise(r => setTimeout(r, 15000));
    response = await makeRequest();
    data = await response.json();
  }

  if (response.status === 429) {
    throw new Error('Rate limit exceeded. Please wait a minute and try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(data.error?.message || 'Invalid API key. Get one at https://platform.openai.com/api-keys');
  }
  if (!response.ok) {
    throw new Error(data.error?.message || `API error: ${response.status}`);
  }

  return parseOpenAIResponse(data);
}

async function saveContextHandoff(compressedMarkdown, messageCount) {
  try {
    const result = await chrome.storage.local.get([CONTEXTS_KEY]);
    let contexts = result[CONTEXTS_KEY] || [];
    const title = extractProjectTitleFromCompression(compressedMarkdown);
    const newContext = {
      id: generateId(),
      type: 'context_handoff',
      timestamp: Date.now(),
      title,
      content: compressedMarkdown,
      messageCount,
      source: 'chatgpt'
    };
    contexts.unshift(newContext);
    if (contexts.length > MAX_CONTEXT_HANDOFFS) {
      contexts = contexts.slice(0, MAX_CONTEXT_HANDOFFS);
    }
    await chrome.storage.local.set({ [CONTEXTS_KEY]: contexts });
    return { success: true, context: newContext };
  } catch (error) {
    console.error('Error saving context handoff:', error);
    return { success: false, error: error.message };
  }
}

async function getContextHandoffs() {
  try {
    const result = await chrome.storage.local.get([CONTEXTS_KEY]);
    return result[CONTEXTS_KEY] || [];
  } catch (error) {
    console.error('Error getting context handoffs:', error);
    return [];
  }
}

async function deleteContextHandoff(contextId) {
  try {
    const result = await chrome.storage.local.get([CONTEXTS_KEY]);
    let contexts = result[CONTEXTS_KEY] || [];
    contexts = contexts.filter(c => c.id !== contextId);
    await chrome.storage.local.set({ [CONTEXTS_KEY]: contexts });
    return { success: true };
  } catch (error) {
    console.error('Error deleting context handoff:', error);
    return { success: false, error: error.message };
  }
}

// ========== Granola MCP Integration ==========

// Generate PKCE code verifier and challenge
function generatePKCE() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  return crypto.subtle.digest('SHA-256', data).then(hash => {
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { verifier, challenge };
  });
}

// Parse WWW-Authenticate header for resource server metadata URL
// Granola uses resource_metadata; RFC 9728 uses resource_server_metadata_uri
function parseWWWAuthenticate(header) {
  if (!header) return null;
  const match = header.match(/resource_metadata="([^"]+)"/) ||
    header.match(/resource_server_metadata_uri="([^"]+)"/);
  return match ? match[1] : null;
}

// Session-scoped MCP call counter for logging
let _mcpCallCount = 0;

// MCP request helper
async function mcpRequest(method, params, token) {
  const callNum = ++_mcpCallCount;
  const id = Date.now();

  // Summarise params for logging (avoid dumping huge token strings)
  const logParams = method === 'tools/call'
    ? { name: params?.name, arguments: params?.arguments }
    : params;
  console.log(`[Memori MCP #${callNum}] → ${method}`, logParams);

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: params || {}
  });
  const headers = {
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26',
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const t0 = Date.now();
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body
  });
  const elapsed = Date.now() - t0;

  if (res.status === 401) {
    console.warn(`[Memori MCP #${callNum}] ← 401 Unauthorized (${elapsed}ms)`);
    const wwwAuth = res.headers.get('WWW-Authenticate') ||
      res.headers.get('x-amzn-remapped-www-authenticate');
    return { needsAuth: true, wwwAuthenticate: wwwAuth };
  }
  if (res.status === 429) {
    console.warn(`[Memori MCP #${callNum}] ← 429 Rate Limited (${elapsed}ms)`);
    throw new Error('Rate limit exceeded. Please slow down requests.');
  }
  if (!res.ok) {
    console.error(`[Memori MCP #${callNum}] ← ${res.status} ${res.statusText} (${elapsed}ms)`);
    throw new Error(`MCP request failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('Content-Type') || '';
  let data;
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    data = parseSSEResponse(text, id);
  } else {
    data = await res.json();
  }

  if (data.error) {
    console.error(`[Memori MCP #${callNum}] ← error (${elapsed}ms)`, data.error);
    throw new Error(data.error.message || 'MCP error');
  }

  // Log response — truncate large text content so the console stays readable
  const result = data.result;
  let logResult = result;
  if (result?.content) {
    logResult = {
      ...result,
      content: result.content.map(c =>
        c.type === 'text' && c.text?.length > 300
          ? { type: 'text', text: c.text.slice(0, 300) + `… [+${c.text.length - 300} chars]` }
          : c
      )
    };
  }
  console.log(`[Memori MCP #${callNum}] ← OK (${elapsed}ms)`, logResult);

  return result;
}

// Parse SSE (Server-Sent Events) response from MCP
function parseSSEResponse(text, requestId) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const msg = JSON.parse(jsonStr);
        if (msg.id === requestId || (msg.result !== undefined) || (msg.error !== undefined)) {
          return msg;
        }
      } catch (_) {
        // Skip malformed lines
      }
    }
  }
  throw new Error('No valid JSON-RPC response in SSE stream');
}

// Discover OAuth endpoints from 401 response
async function discoverOAuthEndpoints(wwwAuthenticate) {
  const metadataUri = parseWWWAuthenticate(wwwAuthenticate);
  if (!metadataUri) {
    throw new Error('Could not discover OAuth endpoints from 401 response');
  }
  const res = await fetch(metadataUri);
  if (!res.ok) throw new Error('Failed to fetch resource metadata');
  const metadata = await res.json();
  const authServers = metadata.authorization_servers || [];
  if (authServers.length === 0) {
    throw new Error('No authorization servers found');
  }
  const first = authServers[0];
  const authServerUrl = typeof first === 'string' ? first : (first.authorization_server_url || first.url || first.issuer);
  const authMetadataUrl = authServerUrl.endsWith('/')
    ? `${authServerUrl}.well-known/oauth-authorization-server`
    : `${authServerUrl}/.well-known/oauth-authorization-server`;
  const authRes = await fetch(authMetadataUrl);
  if (!authRes.ok) throw new Error('Failed to fetch auth server metadata');
  return await authRes.json();
}

// Run OAuth flow and store token
async function granolaAuthenticate() {
  try {
    const initResult = await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Memori', version: '1.0.0' }
    }, null);
    if (!initResult.needsAuth) {
      return { success: false, error: 'Already authenticated or unexpected response' };
    }
    const authMetadata = await discoverOAuthEndpoints(initResult.wwwAuthenticate);
    const { authorization_endpoint, token_endpoint, registration_endpoint } = authMetadata;
    if (!authorization_endpoint || !token_endpoint) {
      throw new Error('Invalid auth server metadata');
    }
    let clientId = authMetadata.client_id;
    const redirectUri = chrome.identity.getRedirectURL();
    if (!clientId && registration_endpoint) {
      const regRes = await fetch(registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'openid profile email offline_access',
          client_name: 'Memori Extension',
          software_id: 'memori-chrome-extension'
        })
      });
      if (regRes.ok) {
        const regData = await regRes.json();
        clientId = regData.client_id;
      } else {
        const regErr = await regRes.text();
        console.warn('[Memori] Dynamic registration failed:', regRes.status, regErr);
      }
    }
    if (!clientId) {
      throw new Error('No client_id available. Granola may require pre-registered OAuth apps.');
    }
    const { verifier, challenge } = await generatePKCE();
    const state = generateId();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://mcp.granola.ai'
    });
    const authUrl = `${authorization_endpoint}?${params}`;
    let redirectUrl;
    try {
      redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
      });
    } catch (err) {
      throw new Error(err.message || 'Authentication was cancelled');
    }
    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code) {
      const error = url.searchParams.get('error') || 'No authorization code received';
      throw new Error(error);
    }
    if (returnedState !== state) {
      throw new Error('State mismatch - possible CSRF');
    }
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      resource: 'https://mcp.granola.ai'
    });
    const tokenRes = await fetch(token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      let errData;
      try {
        errData = JSON.parse(errText);
      } catch (_) {
        errData = { error: 'unknown', error_description: errText || `HTTP ${tokenRes.status}` };
      }
      const msg = errData.error_description || errData.error || `Token exchange failed: ${tokenRes.status}`;
      console.error('[Memori] Token exchange failed:', errData, 'redirect_uri:', redirectUri, 'client_id:', clientId);
      throw new Error(msg);
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;
    await chrome.storage.local.set({
      [GRANOLA_TOKEN_KEY]: accessToken,
      [GRANOLA_REFRESH_KEY]: refreshToken || '',
      [GRANOLA_TOKEN_EXPIRY_KEY]: Date.now() + expiresIn * 1000
    });
    return { success: true };
  } catch (error) {
    console.error('[Memori] Granola auth error:', error);
    return { success: false, error: error.message };
  }
}

// Get stored Granola token
async function getGranolaToken() {
  const result = await chrome.storage.local.get([
    GRANOLA_TOKEN_KEY,
    GRANOLA_TOKEN_EXPIRY_KEY
  ]);
  const token = result[GRANOLA_TOKEN_KEY];
  const expiry = result[GRANOLA_TOKEN_EXPIRY_KEY];
  if (!token) return null;
  if (expiry && Date.now() > expiry - 60000) {
    return null;
  }
  return token;
}

// Check if user is authenticated with Granola
async function granolaCheckAuth() {
  const token = await getGranolaToken();
  return { authenticated: !!token };
}

// Pure-regex XML parser for Granola meeting responses.
// DOMParser is NOT available in service workers, so we parse manually.
function parseGranolaMeetingsXml(text) {
  const meetings = [];
  if (!text || !text.trim()) return meetings;

  // Strategy 0: JSON array or object with a meetings/data array.
  // Granola may return list_meetings as JSON instead of XML.
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed.meetings || parsed.data || parsed.results || []);
      if (Array.isArray(arr) && arr.length > 0) {
        for (const m of arr) {
          if (!m || typeof m !== 'object') continue;
          const id = m.id || m.meeting_id || '';
          if (!id) continue;
          const attendeesRaw = m.attendees || m.participants || [];
          meetings.push({
            id,
            title: m.title || m.name || m.meeting_title || '',
            date: m.date || m.meeting_date || m.start_time || m.started_at || '',
            attendees: Array.isArray(attendeesRaw) ? attendeesRaw : [],
            notes: m.notes || m.summary || m.enhanced_notes || '',
            content: m.notes || m.summary || m.enhanced_notes || ''
          });
        }
        if (meetings.length > 0) return meetings;
      }
    } catch (_) {
      // Not valid JSON — fall through to XML strategies
    }
  }

  // Helper: extract value of a named attribute from a tag attribute string
  function attr(attrStr, name) {
    const m = attrStr.match(new RegExp(name + '="([^"]*)"', 'i'));
    return m ? m[1].trim() : '';
  }

  // Helper: extract content of a named child tag from an XML body string
  function childText(body, tag) {
    const m = body.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return m ? m[1].trim() : '';
  }

  // Strategy 1: <meeting ...>...</meeting> blocks with full bodies
  const blockRe = /<meeting\s([^>]*)>([\s\S]*?)<\/meeting>/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const attrStr = m[1];
    const body    = m[2] || '';

    const id    = attr(attrStr, 'id');
    const title = attr(attrStr, 'title') ||
                  childText(body, 'title') || '';
    const date  = attr(attrStr, 'date') ||
                  attr(attrStr, 'meeting_date') ||
                  childText(body, 'date') || '';

    const attendeesRaw = attr(attrStr, 'attendees');
    let attendees = attendeesRaw ? attendeesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!attendees.length) {
      // Try <attendee>...</attendee> children
      const attRe = /<attendee[^>]*>([\s\S]*?)<\/attendee>/gi;
      let am;
      while ((am = attRe.exec(body)) !== null) {
        const n = am[1].trim();
        if (n) attendees.push(n);
      }
    }

    const notes = childText(body, 'notes') ||
                  childText(body, 'enhanced_notes') ||
                  childText(body, 'summary') ||
                  childText(body, 'summary_text') ||
                  childText(body, 'private_notes') ||
                  body.replace(/<[^>]+>/g, ' ').trim(); // strip remaining tags

    meetings.push({ id, title, date, attendees, notes, content: notes });
  }

  // Strategy 2: self-closing or attribute-only <meeting .../> tags
  if (meetings.length === 0) {
    const selfRe = /<meeting\s([^>]*?)\/>/gi;
    while ((m = selfRe.exec(text)) !== null) {
      const attrStr = m[1];
      meetings.push({
        id: attr(attrStr, 'id'),
        title: attr(attrStr, 'title') || '',
        date: attr(attrStr, 'date') || attr(attrStr, 'meeting_date') || '',
        attendees: [],
        notes: '',
        content: ''
      });
    }
  }

  // Strategy 3: bare id="..." pairs anywhere in the text (last resort)
  if (meetings.length === 0) {
    const idRe = /\bid="([^"]+)"/g;
    while ((m = idRe.exec(text)) !== null) {
      meetings.push({ id: m[1], title: '', date: '', attendees: [], notes: '', content: '' });
    }
  }

  return meetings;
}

function granolaProseMirrorToMarkdown(node) {
  if (!node || typeof node !== 'object') return '';

  const renderChildren = () => (Array.isArray(node.content) ? node.content.map(granolaProseMirrorToMarkdown).join('') : '');

  switch (node.type) {
    case 'doc':
      return renderChildren().trim();
    case 'text': {
      let text = node.text || '';
      const marks = Array.isArray(node.marks) ? node.marks : [];
      for (const mark of marks) {
        if (mark?.type === 'bold') text = `**${text}**`;
        else if (mark?.type === 'italic') text = `*${text}*`;
        else if (mark?.type === 'code') text = `\`${text}\``;
      }
      return text;
    }
    case 'paragraph': {
      const text = renderChildren().trim();
      return text ? `${text}\n\n` : '';
    }
    case 'heading': {
      const level = Math.max(1, Math.min(6, node.attrs?.level || 1));
      const text = renderChildren().trim();
      return text ? `${'#'.repeat(level)} ${text}\n\n` : '';
    }
    case 'bulletList':
      return (Array.isArray(node.content) ? node.content.map(granolaProseMirrorToMarkdown).join('') : '') + '\n';
    case 'orderedList':
      return (Array.isArray(node.content) ? node.content.map((child, idx) => granolaProseMirrorToMarkdown({ ...child, _listIndex: idx + 1 })).join('') : '') + '\n';
    case 'listItem': {
      const text = renderChildren().trim();
      if (!text) return '';
      const prefix = node._listIndex ? `${node._listIndex}. ` : '- ';
      return `${prefix}${text}\n`;
    }
    case 'blockquote': {
      const text = renderChildren().trim();
      return text ? text.split('\n').map(line => `> ${line}`).join('\n') + '\n\n' : '';
    }
    case 'hardBreak':
      return '\n';
    default:
      return renderChildren();
  }
}

function extractMeaningfulText(value, depth = 0) {
  if (depth > 6 || value == null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (/^(text|doc|paragraph|heading|bulletList|orderedList|listItem|hardBreak)$/i.test(trimmed)) {
      return [];
    }
    return [trimmed];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => extractMeaningfulText(item, depth + 1));
  }
  if (typeof value !== 'object') return [];

  if (value.type === 'doc' && Array.isArray(value.content)) {
    const md = granolaProseMirrorToMarkdown(value).trim();
    return md ? [md] : [];
  }

  const preferredKeys = [
    'enhanced_notes',
    'private_notes',
    'notes',
    'summary_markdown',
    'summary_text',
    'summary',
    'markdown',
    'text',
    'body',
    'description',
    'content',
    'note',
    'note_text',
    'last_viewed_panel',
    'panel',
    'document'
  ];

  let results = [];
  for (const key of preferredKeys) {
    if (value[key] !== undefined) {
      results = results.concat(extractMeaningfulText(value[key], depth + 1));
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (preferredKeys.includes(key)) continue;
    if (/^(id|uuid|meeting_id|meetingId|title|name|subject|date|meeting_date|start_time|started_at|attendees|participants|organizer|created_at|updated_at|type|marks|attrs|jsonrpc|role)$/i.test(key)) {
      continue;
    }
    results = results.concat(extractMeaningfulText(nested, depth + 1));
  }

  return results;
}

function extractGranolaNotesFromXml(text) {
  if (!text || typeof text !== 'string') return '';

  const tagNames = ['private_notes', 'enhanced_notes', 'notes', 'summary_text', 'summary'];
  for (const tag of tagNames) {
    const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  }

  return '';
}

function normaliseGranolaMeetingText(text) {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text.replace(/\r/g, '\n').replace(/\u00a0/g, ' ').trim();
  if (/^(text|doc|paragraph|heading|bulletList|orderedList|listItem|hardBreak)$/i.test(cleaned)) {
    return '';
  }

  // Granola sometimes returns XML wrappers around the actual meeting notes.
  if (/<meetings_data\b|<meeting\b|<private_notes\b|<enhanced_notes\b/i.test(cleaned)) {
    const directNotes = extractGranolaNotesFromXml(cleaned);
    if (directNotes) {
      cleaned = directNotes;
    } else {
      const parsed = parseGranolaMeetingsXml(cleaned);
      const extractedNotes = parsed
        .map(m => (m?.notes || m?.content || '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (extractedNotes) cleaned = extractedNotes;
    }
  }

  cleaned = cleaned
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = cleaned.split('\n').map(line => line.trim());
  const compact = [];
  let previousBlank = false;

  for (const line of lines) {
    if (!line) {
      if (!previousBlank && compact.length > 0) compact.push('');
      previousBlank = true;
      continue;
    }

    // Drop obvious low-value filler that bloats the prompt.
    if (/^no summary$/i.test(line)) continue;

    compact.push(line);
    previousBlank = false;
  }

  return compact.join('\n').trim();
}

function chooseBestMeetingText(...sources) {
  const candidates = sources
    .flatMap(source => extractMeaningfulText(source))
    .map(normaliseGranolaMeetingText)
    .filter(Boolean);

  if (candidates.length === 0) return '';

  const unique = [...new Set(candidates)];
  unique.sort((a, b) => b.length - a.length);

  const meaningful = unique.find(text => !isThinMeetingText(text));
  return meaningful || unique[0];
}

function normaliseGranolaMeeting(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = raw.id || raw.meeting_id || raw.meetingId || raw.uuid || raw.meeting_uuid || '';
  if (!id) return null;

  const attendeesRaw = raw.attendees || raw.participants || raw.attendee_names || [];
  let attendees = [];
  if (Array.isArray(attendeesRaw)) {
    attendees = attendeesRaw
      .map(a => {
        if (typeof a === 'string') return a.trim();
        if (a && typeof a === 'object') return (a.name || a.email || '').trim();
        return '';
      })
      .filter(Boolean);
  } else if (typeof attendeesRaw === 'string') {
    attendees = attendeesRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  const notes = chooseBestMeetingText(
    raw.enhanced_notes,
    raw.private_notes,
    raw.notes,
    raw.summary_markdown,
    raw.summary_text,
    raw.summary,
    raw.markdown,
    raw.note,
    raw.note_text,
    raw.body,
    raw.content,
    raw.last_viewed_panel,
    raw.panel,
    raw.document,
    raw.enhancement,
    raw
  );

  return {
    id: String(id),
    title: raw.title || raw.name || raw.meeting_title || raw.subject || '',
    date: raw.date || raw.meeting_date || raw.start_time || raw.started_at || raw.when || '',
    attendees,
    notes: typeof notes === 'string' ? notes : '',
    content: typeof notes === 'string' ? notes : ''
  };
}

function isThinMeetingText(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 120) return true;

  const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
  const nonMetaLines = lines.filter(line => {
    return !/(note creator|from stanford|attendee|participants?|organizer|calendar|meeting date|scheduled|invitees?)/i.test(line);
  });

  return nonMetaLines.join(' ').length < 120;
}

function extractGranolaMeetingsFromToolResult(toolResult) {
  const meetings = [];
  const seenIds = new Set();

  function pushMeeting(raw) {
    const meeting = normaliseGranolaMeeting(raw);
    if (!meeting || !meeting.id || seenIds.has(meeting.id)) return;
    seenIds.add(meeting.id);
    meetings.push(meeting);
  }

  function visit(value, depth = 0) {
    if (depth > 6 || value == null) return;

    if (typeof value === 'string') {
      for (const meeting of parseGranolaMeetingsXml(value)) {
        pushMeeting(meeting);
      }
      return;
    }

    if (Array.isArray(value)) {
      const direct = value.map(normaliseGranolaMeeting).filter(Boolean);
      if (direct.length > 0) {
        direct.forEach(pushMeeting);
        return;
      }
      for (const item of value) visit(item, depth + 1);
      return;
    }

    if (typeof value !== 'object') return;

    pushMeeting(value);

    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        if (typeof item?.text === 'string') visit(item.text, depth + 1);
        if (item?.json !== undefined) visit(item.json, depth + 1);
        if (item?.data !== undefined) visit(item.data, depth + 1);
        if (item?.structuredContent !== undefined) visit(item.structuredContent, depth + 1);
        if (item?.structured_content !== undefined) visit(item.structured_content, depth + 1);
      }
    }

    visit(value.structuredContent, depth + 1);
    visit(value.structured_content, depth + 1);
    visit(value.result, depth + 1);
    visit(value.meetings, depth + 1);
    visit(value.data, depth + 1);
    visit(value.results, depth + 1);
    visit(value.items, depth + 1);
  }

  visit(toolResult);
  return meetings;
}

// Call list_meetings to get meeting IDs, then get_meetings for full notes
async function granolaGetMeetings(dateFrom, dateTo) {
  const token = await getGranolaToken();
  if (!token) {
    return { meetings: [], error: 'Not authenticated' };
  }
  try {
    const initResult = await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Memori', version: '1.0.0' }
    }, token);
    if (initResult && initResult.needsAuth) {
      return { meetings: [], error: 'Session expired. Please reconnect.' };
    }
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateFromStr = dateFrom || thirtyDaysAgo.toISOString().split('T')[0];
    const dateToStr = dateTo || now.toISOString().split('T')[0];
    const listArgs = { date_from: dateFromStr, date_to: dateToStr };
    let listResult = await mcpRequest('tools/call', {
      name: 'list_meetings',
      arguments: listArgs
    }, token);
    const hasContent = listResult?.content?.some(c => c.type === 'text' && c.text?.trim());
    if (!hasContent && listResult) {
      listResult = await mcpRequest('tools/call', { name: 'list_meetings', arguments: {} }, token);
    }
    let meetingIds = [];
    let listMeetings = [];
    let text = '';
    if (listResult) {
      if (listResult.content) {
        const textContent = listResult.content.find(c => c.type === 'text');
        text = textContent ? textContent.text : '';
      }
      if (typeof listResult === 'string') text = listResult;
      listMeetings = parseGranolaMeetingsXml(text);
      if (listMeetings.length === 0 && text) {
        const idMatches = text.match(/id="([^"]+)"/g);
        if (idMatches) {
          meetingIds = idMatches.map(m => m.replace(/id="|"/g, ''));
          listMeetings = idMatches.map((m, i) => ({
            id: meetingIds[i],
            title: 'Meeting',
            date: '',
            attendees: [],
            notes: '',
            content: ''
          }));
        }
      } else {
        meetingIds = listMeetings.map(m => m.id).filter(Boolean);
      }
    }
    if (meetingIds.length === 0 && listMeetings.length === 0) {
      const emptyArgsResult = await mcpRequest('tools/call', {
        name: 'list_meetings',
        arguments: {}
      }, token);
      if (emptyArgsResult && emptyArgsResult.content) {
        const textContent = emptyArgsResult.content.find(c => c.type === 'text');
        const text = textContent ? textContent.text : '';
        if (text) {
          listMeetings = parseGranolaMeetingsXml(text);
          if (listMeetings.length === 0) {
            const idMatches = text.match(/id="([^"]+)"/g);
            if (idMatches) {
              meetingIds = idMatches.map(m => m.replace(/id="|"/g, ''));
              listMeetings = meetingIds.map(id => ({ id, title: 'Meeting', date: '', attendees: [], notes: '', content: '' }));
            }
          } else {
            meetingIds = listMeetings.map(m => m.id).filter(Boolean);
          }
        }
      }
    }
    if (meetingIds.length === 0 && listMeetings.length === 0) {
      return { meetings: [] };
    }
    if (meetingIds.length === 0) {
      return { meetings: listMeetings };
    }
    const meetingsWithNotes = [];
    for (let i = 0; i < listMeetings.length; i++) {
      const m = listMeetings[i];
      const id = m.id;
      if (!id) {
        meetingsWithNotes.push({ ...m });
        continue;
      }
      try {
        const getResult = await mcpRequest('tools/call', {
          name: 'get_meetings',
          arguments: { meeting_ids: [id] }
        }, token);
        let notes = '';
        let richTitle = '';
        let richDate = '';
        let richAttendees = [];
        if (getResult?.content) {
          const textContent = getResult.content.find(c => c.type === 'text');
          const getText = textContent ? textContent.text : '';
          const parsed = parseGranolaMeetingsXml(getText);
          const found = parsed.find(p => p.id === id) || parsed[0];
          notes = found?.notes || found?.content || getText || '';

          // Prefer richer title/date from XML parse
          const xmlTitle = found?.title;
          const xmlDate = found?.date;
          richAttendees = found?.attendees?.length ? found.attendees : [];

          const isBad = t => !t || t === 'Meeting' || t === 'Untitled Meeting';
          if (!isBad(xmlTitle)) {
            richTitle = xmlTitle;
            richDate = xmlDate || '';
          } else {
            // XML parse didn't yield a title — extract from raw text
            const extracted = extractTitleDateFromText(notes);
            richTitle = isBad(extracted.title) ? '' : extracted.title;
            richDate = extracted.date || xmlDate || '';
          }
        }
        meetingsWithNotes.push({
          ...m,
          title: richTitle || m.title || 'Untitled Meeting',
          date: richDate || m.date || '',
          attendees: richAttendees.length ? richAttendees : (m.attendees || []),
          notes,
          content: notes
        });
      } catch (e) {
        meetingsWithNotes.push({ ...m });
      }
    }
    return { meetings: meetingsWithNotes };
  } catch (error) {
    console.error('[Memori] Granola getMeetings error:', error);
    return { meetings: [], error: error.message };
  }
}

// Get meeting details (for inject)
async function granolaGetMeetingDetails(meetingId) {
  const token = await getGranolaToken();
  if (!token) {
    return { error: 'Not authenticated' };
  }
  try {
    await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Memori', version: '1.0.0' }
    }, token);
    const toolResult = await mcpRequest('tools/call', {
      name: 'get_meetings',
      arguments: { meeting_ids: [meetingId] }
    }, token);
    if (!toolResult) {
      return { error: 'No meeting data' };
    }

    const parsedMeetings = extractGranolaMeetingsFromToolResult(toolResult);
    const matched = parsedMeetings.find(m => m.id === meetingId) || parsedMeetings[0];
    const rawText = extractMcpToolText(toolResult);
    const parsedFromRaw = rawText ? parseGranolaMeetingsXml(rawText) : [];
    const rawMatch = parsedFromRaw.find(m => m.id === meetingId) || parsedFromRaw[0];
    const directXmlNotes = extractGranolaNotesFromXml(rawText);

    // Prefer the direct XML note body from get_meetings. This path is the most
    // reliable for Granola and avoids the generic recursive extractor discarding
    // valid XML-backed notes as empty.
    let text = normaliseGranolaMeetingText(directXmlNotes || rawMatch?.notes || rawMatch?.content || rawText);

    // Fallback for non-XML/structured responses.
    if (!text) {
      text = chooseBestMeetingText(
        matched,
        toolResult?.structuredContent,
        toolResult?.structured_content,
        toolResult?.content,
        rawText
      );
    }

    console.log('[Memori] granolaGetMeetingDetails extraction', {
      meetingId,
      parsedCandidatePreview: (matched?.notes || matched?.content || '').slice(0, 400),
      rawTextPreview: (rawText || '').slice(0, 400),
      chosenPreview: (text || '').slice(0, 400)
    });

    if (!text) {
      return { error: 'No meeting data' };
    }
    return { meeting: text };
  } catch (error) {
    return { error: error.message };
  }
}

// Extract meeting title and date from raw meeting text when XML parsing misses them
function extractTitleDateFromText(text) {
  if (!text) return { title: '', date: '' };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let title = '';
  let date = '';

  for (const line of lines) {
    // Markdown headings: # Title or ## Title
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch && !title) {
      title = headingMatch[1].trim();
      continue;
    }
    // Key-value patterns: Title: X, Meeting: X, Name: X
    const kvTitle = line.match(/^(?:title|meeting|name|subject)\s*:\s*(.+)/i);
    if (kvTitle && !title) { title = kvTitle[1].trim(); continue; }
    // Date patterns: Date: X, Time: X, When: X, or ISO-like strings
    const kvDate = line.match(/^(?:date|time|when|scheduled|start)\s*:\s*(.+)/i);
    if (kvDate && !date) { date = kvDate[1].trim(); continue; }
    // ISO date in the line
    const isoDate = line.match(/\b(\d{4}-\d{2}-\d{2}(?:T[\d:Z.+-]+)?)\b/);
    if (isoDate && !date) { date = isoDate[1]; }
  }

  // Last resort: first non-empty, non-symbol line as title
  if (!title && lines.length > 0) {
    const candidate = lines.find(l => l.length > 3 && !/^[-=#*]+$/.test(l));
    title = candidate || '';
  }
  return { title, date };
}

function extractMcpToolText(toolResult) {
  if (!toolResult) return '';
  if (typeof toolResult === 'string') return toolResult.trim();
  if (Array.isArray(toolResult.content)) {
    const textParts = toolResult.content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text.trim())
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('\n\n');
  }
  const structured = toolResult.structuredContent || toolResult.structured_content;
  if (structured !== undefined) {
    try {
      return typeof structured === 'string' ? structured.trim() : JSON.stringify(structured, null, 2);
    } catch (_) {
      // Ignore serialization failures and keep falling through.
    }
  }
  if (typeof toolResult.text === 'string') return toolResult.text.trim();
  return '';
}

function selectGranolaChatTool(tools) {
  if (!Array.isArray(tools)) return null;
  const preferred = tools.find(t => t?.name === 'query_granola_meetings');
  if (preferred) return preferred;
  const exact = tools.find(t => t?.name === 'chat_with_granola');
  if (exact) return exact;
  const fuzzy = tools.find(t => {
    const n = (t?.name || '').toLowerCase();
    return n.includes('chat') && n.includes('granola');
  });
  if (fuzzy) return fuzzy;
  return tools.find(t => (t?.name || '').toLowerCase().includes('chat')) || null;
}

function buildChatToolArgs(toolDef, question) {
  const schemaProps = toolDef?.inputSchema?.properties || {};
  const preferredKeys = ['query', 'question', 'prompt', 'message', 'input', 'text'];
  const key = preferredKeys.find(k => Object.prototype.hasOwnProperty.call(schemaProps, k)) || 'query';
  return { [key]: question };
}

async function granolaChatWithGranola(userQuery) {
  const token = await getGranolaToken();
  if (!token) return { error: 'Not authenticated', needsAuth: true };

  try {
    const initResult = await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Memori', version: '1.0.0' }
    }, token);
    if (initResult && initResult.needsAuth) {
      return { error: 'Session expired. Please reconnect.', needsAuth: true };
    }

    const toolsList = await mcpRequest('tools/list', {}, token);
    const chatTool = selectGranolaChatTool(toolsList?.tools || []);
    if (!chatTool?.name) {
      return { error: 'Granola chat tool not found in MCP tools/list.' };
    }

    const question = [
      'Use my Granola meeting context to answer this user request.',
      `User request: ${userQuery}`,
      'If relevant context is missing, say that explicitly.'
    ].join('\n');

    // Exactly one chat tool call.
    const toolResult = await mcpRequest('tools/call', {
      name: chatTool.name,
      arguments: buildChatToolArgs(chatTool, question)
    }, token);

    const contextText = extractMcpToolText(toolResult);
    if (!contextText) {
      return { error: 'Granola returned no context text.' };
    }
    return { contextText };
  } catch (error) {
    console.error('[Memori] Granola chat call failed:', error);
    return { error: error.message };
  }
}

// meetingNames: optional Map<url, name> used to show meeting names instead of raw URLs
function cleanGranolaContext(raw, meetingNames) {
  // Collect unique citation URLs from [[n]](url) patterns
  const citationPattern = /\s*\[\[\d+\]\]\((https?:\/\/[^)]+)\)/g;
  const seenUrls = new Set();
  const urls = [];
  let match;
  while ((match = citationPattern.exec(raw)) !== null) {
    if (!seenUrls.has(match[1])) {
      seenUrls.add(match[1]);
      urls.push(match[1]);
    }
  }

  // Strip all inline citations from the body text
  const cleanedText = raw.replace(/\s*\[\[\d+\]\]\(https?:\/\/[^)]+\)/g, '').trim();

  if (urls.length === 0) return cleanedText;

  // Resolve each URL to a meeting name when possible
  const names = urls.map(url => {
    if (meetingNames && meetingNames.has(url)) return meetingNames.get(url);
    // Fall back to extracting the UUID from the URL as a short identifier
    const uuidMatch = url.match(/\/d\/([\w-]+)\/?$/);
    return uuidMatch ? uuidMatch[1] : url;
  });

  const sourceLine = 'Source meeting(s): ' + names.join(' | ');
  return sourceLine + '\n\n' + cleanedText;
}

function composeGranolaGroundedPrompt(userQuery, granolaContext, meetingNames) {
  const sections = [
    'Answer the question using only the selected Granola meeting context below where relevant.',

    '## My Question\n\n' + userQuery,

    '## Context from My Granola Meeting Notes\n\n' + cleanGranolaContext(granolaContext, meetingNames),

    [
      '## How I\'d Like You to Respond',
      '',
      'Be concise and direct. Skip preamble and get straight to the answer.',
      '',
      '- **Answer the question first.** Lead with the most useful, actionable insight.',
      '',
      '- **Use only the selected meetings above.** Do not mention or rely on any excluded meetings.',
      '',
      '- **Personalize around preferences.** If the meeting context mentions foods, meals, exercises, routines, or habits I like, dislike, avoid, prefer, or struggle with, explicitly use those preferences to shape the recommendations.',
      '',
      '- **Reference preferences concretely.** For example, if I dislike a food or workout, do not recommend it as the default plan; if I prefer a certain food, exercise, or routine, use that as the starting point when it fits.',
      '',
      '- **Keep it to one page max.** Aim for a concise response, roughly 6-10 bullets or a very short numbered list.',
      '',
      '- **Summarize, don\'t dump notes.** Synthesize the meeting context into advice instead of repeating raw details.',
      '',
      '- If the context doesn\'t cover the question, say so in one sentence and give your best general answer.'
    ].join('\n')
  ];

  return sections.join('\n\n\n');
}

// Optimised M-send flow — exactly 4 MCP calls, no get_meetings at all:
//   1. initialize
//   2. list_meetings           → lightweight stubs (id + title + date)
//   3. tools/list              → find the chat tool name
//   4. query_granola_meetings  → synthesised context + cited meeting IDs
//
// The query_granola_meetings response already contains the full meeting
// context synthesised by Granola — we store it and use it directly in
// the final prompt, avoiding any get_meetings calls.
async function granolaFetchMeetingsForQuery(userQuery) {
  const token = await getGranolaToken();
  if (!token) return { meetings: [], error: 'Not authenticated', needsAuth: true };

  console.log('[Memori] granolaFetchMeetingsForQuery — resetting session call counter');
  _mcpCallCount = 0;

  try {
    // 1. Initialize (once, shared)
    const initResult = await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Memori', version: '1.0.0' }
    }, token);
    if (initResult?.needsAuth) return { meetings: [], error: 'Session expired', needsAuth: true };

    // 2. list_meetings — IDs + titles + dates, no notes.
    // Do NOT pass a date range here. Using a fixed window (e.g. 90 days) means
    // query_granola_meetings can surface older meetings that list_meetings would
    // never include, causing an ID mismatch and an empty result. Let Granola
    // scope the window by the user's plan (30 days Basic, unlimited on paid).
    let listResult = await mcpRequest('tools/call', {
      name: 'list_meetings',
      arguments: {}
    }, token);

    const listText = extractMcpToolText(listResult);
    let allStubs = extractGranolaMeetingsFromToolResult(listResult);

    if (allStubs.length === 0 && listText) {
      allStubs = parseGranolaMeetingsXml(listText);
    }

    // Last-resort: pull bare id="..." attribute values if the full parser found nothing.
    if (allStubs.length === 0 && listText) {
      const idMatches = listText.match(/id="([^"]+)"/g) || [];
      allStubs = idMatches.map(m => ({
        id: m.replace(/id="|"/g, ''), title: '', date: '', attendees: [], notes: '', content: ''
      }));
    }
    console.log('[Memori] list_meetings extraction', {
      listResult,
      listTextPreview: listText ? listText.slice(0, 1000) : '',
      extractedStubCount: allStubs.length,
      extractedStubIds: allStubs.map(s => s.id).filter(Boolean)
    });
    if (allStubs.length === 0) return { meetings: [], synthesizedContext: '' };

    // 3. tools/list — discover the chat tool name
    const toolsList = await mcpRequest('tools/list', {}, token);
    const chatTool = selectGranolaChatTool(toolsList?.tools || []);

    // 4. query_granola_meetings — Granola synthesises context and cites meetings
    let synthesizedContext = '';
    const relevantIds = new Set();

    if (chatTool?.name) {
      // Ask Granola to find and cite ALL relevant meetings, not just answer the question.
      // "Answer this request" causes Granola to synthesize a concise response and only
      // cite the top 1-2 meetings. We need comprehensive citation of every relevant meeting.
      const question = [
        `User request: ${userQuery}`,
        '',
        'Search my meeting notes for ALL meetings that are relevant to this request.',
        'For every relevant meeting you find — even ones that are only tangentially related — include its citation link.',
        'Be exhaustive: do not omit meetings just because another meeting is more relevant.',
        'After citing all relevant meetings, summarize the key context from each one.'
      ].join('\n');
      const chatResult = await mcpRequest('tools/call', {
        name: chatTool.name,
        arguments: buildChatToolArgs(chatTool, question)
      }, token);
      synthesizedContext = extractMcpToolText(chatResult);

      // Extract meeting UUIDs from citation URLs anywhere in the response.
      // Granola may format citations as bare URLs or as [[n]](url) markdown links.
      const urlPattern = /https?:\/\/(?:notes|app)\.granola\.ai\/(?:d|doc|meetings?)\/([0-9a-f-]{8,})/gi;
      let urlMatch;
      while ((urlMatch = urlPattern.exec(synthesizedContext)) !== null) {
        relevantIds.add(urlMatch[1].toLowerCase());
      }
      console.log('[Memori] query_granola_meetings extraction', {
        synthesizedContextPreview: synthesizedContext ? synthesizedContext.slice(0, 1500) : '',
        relevantIds: Array.from(relevantIds)
      });
    }

    console.log(`[Memori] granolaFetchMeetingsForQuery — total MCP calls: ${_mcpCallCount}`);

    // Filter stubs to cited/relevant ones, deduplicate by ID.
    // relevantIds are lowercased so normalise stub IDs when comparing.
    const seenIds = new Set();
    let rawRelevant;
    if (relevantIds.size > 0) {
      const matched = allStubs.filter(s => relevantIds.has((s.id || '').toLowerCase()));
      // If citation IDs were found but none match the stubs (e.g. the cited meetings
      // are outside the window returned by list_meetings), fall back to all stubs so
      // the user still sees something rather than an empty list.
      rawRelevant = matched.length > 0 ? matched : allStubs;
      console.log('[Memori] meeting match results', {
        allStubIds: allStubs.map(s => s.id).filter(Boolean),
        matchedIds: matched.map(s => s.id).filter(Boolean),
        returnedIds: rawRelevant.map(s => s.id).filter(Boolean)
      });
    } else {
      rawRelevant = allStubs;
    }
    const relevantStubs = rawRelevant.filter(s => {
      if (!s.id || seenIds.has(s.id)) return false;
      seenIds.add(s.id);
      return true;
    });

    // Build url→name map so the prompt shows meeting names instead of raw URLs.
    // The citation URLs contain the meeting UUID; stubs have the same UUIDs as IDs.
    const meetingNameMap = {};
    for (const stub of relevantStubs) {
      if (stub.id && stub.title) {
        // Map both the full notes URL and the bare UUID
        meetingNameMap[`https://notes.granola.ai/d/${stub.id}`] = stub.title;
      }
    }

    return {
      meetings: relevantStubs,      // stubs with title + date from list_meetings
      synthesizedContext,           // full Granola-synthesised context for the prompt
      meetingNameMap,               // url → meeting title for clean source attribution
      needsAuth: false
    };
  } catch (error) {
    console.error('[Memori] granolaFetchMeetingsForQuery error:', error);
    return { meetings: [], synthesizedContext: '', error: error.message };
  }
}

// Get cached Granola meetings (no API call)
async function getGranolaMeetingsCached() {
  try {
    const result = await chrome.storage.local.get([GRANOLA_MEETINGS_CACHE_KEY]);
    const cached = result[GRANOLA_MEETINGS_CACHE_KEY];
    return { meetings: cached?.meetings || [], cachedAt: cached?.cachedAt || null };
  } catch (error) {
    console.error('[Memori] Error getting Granola cache:', error);
    return { meetings: [], cachedAt: null };
  }
}

// Fetch from Granola API and update cache
async function granolaFetchAndCacheMeetings(dateFrom, dateTo) {
  const result = await granolaGetMeetings(dateFrom, dateTo);
  if (!result.error && result.meetings) {
    await chrome.storage.local.set({
      [GRANOLA_MEETINGS_CACHE_KEY]: {
        meetings: result.meetings,
        cachedAt: Date.now()
      }
    });
  }
  return result;
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveMemory') {
    saveMemory(request.text, request.type || 'user', request.messageCount).then(sendResponse);
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
    return true;
  }

  if (request.action === 'granolaAuthenticate') {
    granolaAuthenticate().then(sendResponse);
    return true;
  }

  if (request.action === 'granolaCheckAuth') {
    granolaCheckAuth().then(sendResponse);
    return true;
  }

  if (request.action === 'granolaGroundedComposePrompt') {
    (async () => {
      const userQuery = (request.userQuery || '').trim();
      if (!userQuery) {
        sendResponse({ success: false, error: 'User query is empty.' });
        return;
      }
      let granolaResult = await granolaChatWithGranola(userQuery);
      if (granolaResult.needsAuth) {
        const auth = await granolaAuthenticate();
        if (!auth.success) {
          sendResponse({ success: false, error: auth.error || 'Granola authentication failed.' });
          return;
        }
        // Retry exactly once after successful auth.
        granolaResult = await granolaChatWithGranola(userQuery);
      }
      if (granolaResult.error) {
        sendResponse({ success: false, error: granolaResult.error });
        return;
      }
      const composedPrompt = composeGranolaGroundedPrompt(userQuery, granolaResult.contextText);
      sendResponse({ success: true, composedPrompt });
    })();
    return true;
  }

  if (request.action === 'granolaGetMeetings') {
    granolaGetMeetings(request.dateFrom, request.dateTo).then(sendResponse);
    return true;
  }

  if (request.action === 'getGranolaMeetingsCached') {
    getGranolaMeetingsCached().then(sendResponse);
    return true;
  }

  if (request.action === 'granolaFetchAndCacheMeetings') {
    granolaFetchAndCacheMeetings(request.dateFrom, request.dateTo).then(sendResponse);
    return true;
  }

  if (request.action === 'granolaGetMeetingDetails') {
    granolaGetMeetingDetails(request.meetingId).then(sendResponse);
    return true;
  }

  if (request.action === 'compressAndSaveContext') {
    (async () => {
      try {
        const { openai_api_key } = await chrome.storage.local.get([OPENAI_API_KEY_KEY]);
        if (!openai_api_key || !openai_api_key.trim()) {
          sendResponse({ success: false, error: 'API key required', needsApiKey: true });
          return;
        }
        const msgCount = request.conversation?.length || 0;
        let compressed;
        try {
          compressed = await compressContext(request.conversation, openai_api_key.trim());
        } catch (err) {
          const rawTranscript = request.conversation.map(m => {
            const label = m.role === 'user' ? 'User' : 'Assistant';
            return `${label}: ${m.content}`;
          }).join('\n\n');
          compressed = `## CONTEXT HANDOFF (Compression failed)\n\n**Error:** ${err.message}\n\n### Raw transcript\n\n${rawTranscript}`;
        }
        const saveResult = await saveContextHandoff(compressed, msgCount);
        if (saveResult.success) {
          sendResponse({ success: true, messageCount: msgCount, context: saveResult.context });
        } else {
          sendResponse({ success: false, error: saveResult.error });
        }
      } catch (err) {
        console.error('[Memori] compressAndSaveContext error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'getContextHandoffs') {
    getContextHandoffs().then(sendResponse);
    return true;
  }

  if (request.action === 'deleteContextHandoff') {
    deleteContextHandoff(request.contextId).then(sendResponse);
    return true;
  }

  if (request.action === 'granolaFetchMeetingsForQuery') {
    (async () => {
      const result = await granolaFetchMeetingsForQuery(request.userQuery || '');
      if (result.needsAuth) {
        const auth = await granolaAuthenticate();
        if (!auth.success) {
          sendResponse({ error: auth.error || 'Granola authentication failed', meetings: [] });
          return;
        }
        const retry = await granolaFetchMeetingsForQuery(request.userQuery || '');
        sendResponse(retry);
      } else {
        sendResponse(result);
      }
    })();
    return true;
  }

  if (request.action === 'composeGroundedPromptFromMeetings') {
    const { userQuery, meetingsContext, meetingNameMap } = request;
    // Rebuild Map from plain object (can't send Map over chrome.runtime.sendMessage)
    const namesMap = meetingNameMap
      ? new Map(Object.entries(meetingNameMap))
      : undefined;
    const composedPrompt = composeGranolaGroundedPrompt(userQuery || '', meetingsContext || '', namesMap);
    sendResponse({ success: true, composedPrompt });
    return true;
  }

  if (request.action === 'getOpenAIApiKey') {
    chrome.storage.local.get([OPENAI_API_KEY_KEY]).then(r => sendResponse({ key: r[OPENAI_API_KEY_KEY] || '' }));
    return true;
  }

  if (request.action === 'saveOpenAIApiKey') {
    chrome.storage.local.set({ [OPENAI_API_KEY_KEY]: request.key || '' }).then(() => sendResponse({ success: true }));
    return true;
  }

  return false;
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  // Only work on supported AI chat pages
  if (tab.url && (tab.url.includes('chat.openai.com') || tab.url.includes('chatgpt.com') || tab.url.includes('claude.ai') || tab.url.includes('gemini.google.com'))) {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' }).catch(err => {
      console.error('[Memori] Error sending message to content script:', err);
    });
  } else {
    console.log('[Memori] Not a supported chat page:', tab.url);
  }
});
