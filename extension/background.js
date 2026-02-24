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

// MCP request helper
async function mcpRequest(method, params, token) {
  const id = Date.now();
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
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body
  });
  if (res.status === 401) {
    const wwwAuth = res.headers.get('WWW-Authenticate') ||
      res.headers.get('x-amzn-remapped-www-authenticate');
    return { needsAuth: true, wwwAuthenticate: wwwAuth };
  }
  if (!res.ok) {
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
    throw new Error(data.error.message || 'MCP error');
  }
  return data.result;
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

// Parse Granola XML/HTML-like response (e.g. <meetings_data><meeting id="..." title="...">...</meeting></meetings_data>)
function parseGranolaMeetingsXml(text) {
  const meetings = [];
  if (!text || !text.trim()) return meetings;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString('<root>' + text + '</root>', 'text/xml');
    const meetingEls = doc.querySelectorAll('meeting');
    for (const el of meetingEls) {
      const id = el.getAttribute('id') || '';
      const title = el.getAttribute('title') || el.querySelector('title')?.textContent?.trim() || 'Untitled Meeting';
      const date = el.getAttribute('date') || el.getAttribute('meeting_date') || el.querySelector('date')?.textContent?.trim() || '';
      const attendeesEl = el.querySelector('attendees');
      let attendees = [];
      if (attendeesEl) {
        const items = attendeesEl.querySelectorAll('attendee');
        attendees = Array.from(items).map(a => a.textContent?.trim()).filter(Boolean);
      } else {
        const attrs = el.getAttribute('attendees');
        if (attrs) attendees = attrs.split(',').map(s => s.trim());
      }
      const notesEl = el.querySelector('notes') || el.querySelector('enhanced_notes') || el.querySelector('summary') || el.querySelector('summary_text');
      const notes = notesEl ? notesEl.textContent?.trim() : '';
      const privateNotesEl = el.querySelector('private_notes');
      const privateNotes = privateNotesEl ? privateNotesEl.textContent?.trim() : '';
      const innerText = (el.textContent || '').trim();
      const content = (notes || privateNotes || innerText).trim();
      meetings.push({
        id,
        title,
        date,
        attendees,
        notes: notes || privateNotes,
        content: content
      });
    }
    if (meetings.length === 0) {
      const meetingRegex = /<meeting\s+([^>]+)>([\s\S]*?)<\/meeting>/gi;
      let m;
      while ((m = meetingRegex.exec(text)) !== null) {
        const attrs = m[1];
        const body = (m[2] || '').trim();
        const idMatch = attrs.match(/id="([^"]*)"/);
        const titleMatch = attrs.match(/title="([^"]*)"/);
        const dateMatch = attrs.match(/date="([^"]*)"/);
        meetings.push({
          id: idMatch ? idMatch[1] : '',
          title: titleMatch ? titleMatch[1] : 'Meeting',
          date: dateMatch ? dateMatch[1] : '',
          attendees: [],
          notes: body,
          content: body
        });
      }
    }
    if (meetings.length === 0) {
      const tagMatch = text.match(/<meeting[^>]*id="([^"]*)"[^>]*title="([^"]*)"[^>]*\/?>/g);
      if (tagMatch) {
        for (const tag of tagMatch) {
          const idMatch = tag.match(/id="([^"]*)"/);
          const titleMatch = tag.match(/title="([^"]*)"/);
          meetings.push({
            id: idMatch ? idMatch[1] : '',
            title: titleMatch ? titleMatch[1] : 'Meeting',
            date: '',
            attendees: [],
            notes: '',
            content: ''
          });
        }
      }
    }
  } catch (e) {
    console.warn('[Memori] XML parse fallback:', e);
  }
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
        if (getResult?.content) {
          const textContent = getResult.content.find(c => c.type === 'text');
          const getText = textContent ? textContent.text : '';
          const parsed = parseGranolaMeetingsXml(getText);
          const found = parsed.find(p => p.id === id) || parsed[0];
          notes = found?.notes || found?.content || getText || '';
        }
        meetingsWithNotes.push({ ...m, notes, content: notes });
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
    if (!toolResult || !toolResult.content) {
      return { error: 'No meeting data' };
    }
    const textContent = toolResult.content.find(c => c.type === 'text');
    const text = textContent ? textContent.text : '';
    return { meeting: text };
  } catch (error) {
    return { error: error.message };
  }
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

function composeGranolaGroundedPrompt(userQuery, granolaContext) {
  return [
    'You are answering the user by grounding in the provided Granola context.',
    '',
    '## User Original Query',
    userQuery,
    '',
    '## Granola Context',
    granolaContext,
    '',
    '## Instructions',
    '- Answer the user query directly.',
    '- Ground your response in the Granola Context above.',
    '- If the context is insufficient or uncertain, say so explicitly.',
    '- Do not fabricate details not supported by the context.'
  ].join('\n');
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
  // Only work on ChatGPT pages
  if (tab.url && (tab.url.includes('chat.openai.com') || tab.url.includes('chatgpt.com'))) {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' }).catch(err => {
      console.error('[Memori] Error sending message to content script:', err);
    });
  } else {
    console.log('[Memori] Not a ChatGPT page:', tab.url);
  }
});
