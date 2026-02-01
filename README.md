# Memori - ChatGPT Memory Sidebar Extension

A Chrome Extension (Manifest V3) that adds a sidebar memory panel for ChatGPT. Save snippets of text, automatically capture conversations, and inject them back into your chats.

## Features

- ✅ **Manual Save Button** - Save any text from ChatGPT input with one click
- ✅ **Auto-Capture** - Automatically save your messages and ChatGPT's responses
- ✅ **Sidebar Memory Panel** - View all saved memories in a convenient sidebar
- ✅ **Inject Memories** - Paste saved memories back into ChatGPT input
- ✅ **Visual Distinction** - User messages and assistant responses are clearly labeled
- ✅ **Delete Memories** - Remove memories you no longer need
- ✅ **Smart Storage** - Stores up to 50 most recent memories (FIFO)
- ✅ **Works on ChatGPT** - Supports both `chat.openai.com` and `www.chatgpt.com`

## Architecture

- **Content Script** (`contentScript.js`): Injects UI elements, handles input detection, and manages sidebar
- **Background Service Worker** (`background.js`): Handles memory storage/retrieval using `chrome.storage.local`
- **Sidebar UI**: Dynamically injected HTML/CSS displaying memories with type indicators
- **Memory Format**: `{id, text, timestamp, type}` where type is 'user' or 'assistant'

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `Memori/extension` folder
6. The extension icon should appear in your Chrome toolbar

## Usage

### Manual Save

1. Navigate to [ChatGPT](https://chat.openai.com) or [www.chatgpt.com](https://www.chatgpt.com)
2. Type text in the ChatGPT input box
3. Click the **"💾 Save to memory"** button (bottom-right corner)
4. You'll see a brief "✓ Saved!" confirmation

### Auto-Capture

1. Open the Memori sidebar (click extension icon in Chrome toolbar)
2. Enable **"Auto-capture sent messages"** toggle
3. When enabled, the extension will automatically:
   - Save your messages when you send them
   - Save ChatGPT's responses after they're generated
4. Both are saved with visual indicators (👤 You / 🤖 Assistant)

### View Memories

1. Click the extension icon in Chrome toolbar
2. The sidebar opens from the right side
3. All saved memories are displayed with:
   - Type indicator (👤 You or 🤖 Assistant)
   - Timestamp (relative time like "5m ago")
   - Full text content
   - Action buttons (Inject/Delete)

### Inject Memories

1. Open the Memori sidebar
2. Find a memory you want to use
3. Click the **Inject** button
4. The memory text is appended to ChatGPT's input box
5. You can edit it before sending (does NOT auto-submit)

### Delete Memories

1. Open the Memori sidebar
2. Find the memory you want to delete
3. Click the **Delete** button
4. The memory is immediately removed

## File Structure

```
Memori/
├── extension/
│   ├── manifest.json       # Extension configuration (Manifest V3)
│   ├── background.js       # Service worker for storage management
│   ├── contentScript.js    # Main injection logic and UI management
│   ├── sidebar.css         # Sidebar styles (injected inline)
│   ├── sidebar.js          # Sidebar initialization
│   └── sidebar.html        # Reference (HTML is injected dynamically)
├── README.md               # This file
├── DEBUG.md                # Debugging guide
└── TROUBLESHOOTING.md      # Troubleshooting guide
```

## How It Works

### Input Detection
- Automatically finds ChatGPT's input element (supports both textarea and contenteditable)
- Prioritizes visible elements over hidden fallback elements
- Handles dynamic DOM updates

### Auto-Capture
- **User Messages**: Captured on send button click, Enter key, or form submission
- **Assistant Responses**: Detected via DOM mutation observer, waits for complete response
- Both types are saved with appropriate labels

### Memory Storage
- Stored in `chrome.storage.local` (browser local storage)
- Maximum 50 memories (FIFO - oldest removed when limit reached)
- Each memory includes: id, text, timestamp, and type

### Sidebar
- Fixed position on right side of page
- Scrollable list of memories
- Visual distinction between user and assistant messages
- Real-time updates when memories are added/deleted

## Settings

- **Auto-Capture Toggle**: Enable/disable automatic saving of messages and responses
- Settings are persisted across page reloads

## Limitations

- DOM selectors may break if ChatGPT updates their UI significantly
- Only works on ChatGPT domains (`chat.openai.com`, `www.chatgpt.com`)
- Memories stored locally (not synced across devices)
- No search or filtering functionality
- No export/import functionality
- Maximum 50 memories (oldest automatically removed)

## Troubleshooting

### Save button not appearing
- Refresh the ChatGPT page
- Check browser console (F12) for `[Memori]` messages
- Verify extension is enabled in `chrome://extensions/`
- Make sure you're on a supported ChatGPT domain

### Sidebar not opening
- Click the extension icon in Chrome toolbar
- Check that you're on `chat.openai.com` or `www.chatgpt.com`
- Refresh the page and try again
- Check console for errors

### Auto-capture not working
- Make sure auto-capture toggle is enabled in sidebar
- Check console for `[Memori] Auto-capture enabled` message
- Verify you're sending messages normally (Enter key or send button)
- Check console logs for capture attempts

### Text not being captured
- Check console for `[Memori]` debug messages
- Verify input element is being found
- Try manual save button as a test
- See `DEBUG.md` for detailed debugging steps

### Inject not working
- Make sure ChatGPT input box is visible
- Try clicking in the input box first, then inject
- Check browser console for errors
- Verify the memory text is not empty

## Development

- **Manifest Version**: V3
- **Language**: Plain JavaScript (no frameworks)
- **Content Script**: Runs on `document_idle` for better compatibility
- **Storage**: Chrome's local storage API
- **Browser Support**: Chrome/Chromium-based browsers

## Contributing

This is a simple prototype. If ChatGPT updates their UI, the DOM selectors may need to be updated in `contentScript.js`.

## License

This project is provided as-is for personal use.
