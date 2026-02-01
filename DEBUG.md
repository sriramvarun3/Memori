# Memori Extension Debugging Guide

## Step 1: Verify Extension is Loaded

1. Go to `chrome://extensions/`
2. Make sure **Developer mode** is ON (top right)
3. Find "Memori - ChatGPT Memory Sidebar"
4. Verify it shows **Enabled** (toggle should be ON)
5. Check for any errors in red text below the extension name

## Step 2: Check Content Script Injection

1. Go to `www.chatgpt.com` (or `chat.openai.com`)
2. Open Developer Tools:
   - **Windows/Linux**: Press `F12` or `Ctrl+Shift+I`
   - **Mac**: Press `Cmd+Option+I`
3. Go to the **Console** tab
4. Look for messages starting with `[Memori]`
   - You should see: `[Memori] Content script file loaded!`
   - You should see: `[Memori] Document ready state: ...`
   - You should see: `[Memori] Input found, injecting button` (if input is found)

## Step 3: Check if Content Script is Running

In the Console, type:
```javascript
document.getElementById('memori-save-btn')
```

- If it returns `null`, the button wasn't created
- If it returns an element, the button exists but might be hidden

## Step 4: Check Extension Permissions

1. Go to `chrome://extensions/`
2. Click **Details** on the Memori extension
3. Scroll to **Site access**
4. Make sure it has access to `www.chatgpt.com`

## Step 5: Manual Test - Try Injecting Button

In the Console on ChatGPT page, paste this:
```javascript
const btn = document.createElement('button');
btn.id = 'memori-test-btn';
btn.textContent = 'TEST BUTTON';
btn.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 999999; padding: 10px; background: red; color: white;';
document.body.appendChild(btn);
```

If you see a red "TEST BUTTON" in the bottom right, the page allows script injection.

## Step 6: Check for Content Script Errors

1. In Developer Tools, go to **Console** tab
2. Look for any red error messages
3. Check the **Sources** tab → look for `contentScript.js`
4. Set a breakpoint at the first line to see if it executes

## Step 7: Verify Manifest Matches

The manifest should include:
- `"matches": ["https://chat.openai.com/*", "https://www.chatgpt.com/*"]`

## Step 8: Reload Everything

1. In `chrome://extensions/`, click the **reload** icon on Memori extension
2. **Hard refresh** the ChatGPT page: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)
3. Check console again

## Common Issues

### Issue: No `[Memori]` messages in console
**Solution**: Content script isn't loading. Check:
- Extension is enabled
- Manifest matches the URL you're on
- No errors in `chrome://extensions/`

### Issue: `[Memori] Content script file loaded!` but no button
**Solution**: Input element not found. Check:
- Look for `[Memori] Input found` message
- Try the manual test button (Step 5)
- The button should appear anyway (fixed position)

### Issue: Button exists but is hidden
**Solution**: CSS issue. Check:
- Run: `document.getElementById('memori-save-btn').style.display`
- Should not be 'none'
- Check z-index conflicts

## Quick Fix: Force Button Creation

If nothing works, in the Console on ChatGPT page:
```javascript
// Force create button
const btn = document.createElement('button');
btn.id = 'memori-save-btn';
btn.textContent = '💾 Save to memory';
btn.style.cssText = 'position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; background: #10a37f; color: white; border: none; border-radius: 8px; font-size: 13px; z-index: 999998; cursor: pointer;';
btn.onclick = async () => {
  const input = document.querySelector('textarea') || document.querySelector('div[contenteditable="true"]');
  if (input) {
    const text = input.value || input.innerText || '';
    if (text.trim()) {
      chrome.runtime.sendMessage({action: 'saveMemory', text: text}, (response) => {
        alert(response.success ? 'Saved!' : 'Error: ' + response.error);
      });
    } else {
      alert('Input is empty');
    }
  } else {
    alert('Could not find input');
  }
};
document.body.appendChild(btn);
console.log('Button created manually');
```
