# Troubleshooting: Content Script Not Loading

If you see **no [Memori] messages** and **contentScript.js is not in Sources**, the content script isn't being injected. Follow these steps:

## Step 1: Check Extension Errors

1. Go to `chrome://extensions/`
2. Find "Memori - ChatGPT Memory Sidebar"
3. Look for **red error text** below the extension name
4. Click **Errors** or **Details** if available
5. **Take a screenshot** or copy any error messages

## Step 2: Verify Extension is Enabled

1. In `chrome://extensions/`
2. Make sure the **toggle switch** next to Memori is **ON** (blue/enabled)
3. If it's off, turn it on

## Step 3: Check Site Access

1. In `chrome://extensions/`, click **Details** on Memori
2. Scroll to **Site access**
3. Make sure it says "On chat.openai.com" or "On all sites" or "On click"
4. If it says "On click", you may need to click the extension icon first

## Step 4: Verify You're on the Right URL

1. Go to `www.chatgpt.com`
2. Check the **exact URL** in the address bar
3. It should be something like:
   - `https://www.chatgpt.com/` or
   - `https://www.chatgpt.com/c/...` or
   - `https://chat.openai.com/`

## Step 5: Check Extension Service Worker

1. In `chrome://extensions/`
2. Find Memori extension
3. Click **"service worker"** link (if available)
4. This opens the background script console
5. Check for any errors there

## Step 6: Manual Reload

1. In `chrome://extensions/`
2. **Remove** the Memori extension (click Remove)
3. Click **Load unpacked** again
4. Select the `Memori/extension` folder
5. Go to ChatGPT and refresh

## Step 7: Check Chrome Console for Extension Errors

1. Open Developer Tools on ChatGPT page
2. Go to **Console** tab
3. Look for messages starting with `chrome-extension://`
4. Or filter by "Error" or "Failed"

## Step 8: Test with a Simple Content Script

If nothing works, let's verify content scripts work at all:

1. Create a test file `test.js` in the extension folder with just:
   ```javascript
   console.log('TEST SCRIPT LOADED!');
   alert('Content script works!');
   ```

2. Add it to manifest:
   ```json
   "js": ["test.js", "contentScript.js"],
   ```

3. Reload extension and refresh ChatGPT
4. If you see the alert, content scripts work - the issue is with contentScript.js
5. If you don't see the alert, there's a deeper issue

## Step 9: Check File Permissions

On Mac/Linux, make sure files are readable:
```bash
chmod 644 Memori/extension/*.js
chmod 644 Memori/extension/*.json
```

## Step 10: Verify File Encoding

Make sure all files are UTF-8 encoded (they should be by default).

## Common Issues

### Issue: "This extension may have been corrupted"
**Solution**: Remove and re-add the extension

### Issue: "Manifest file is missing or unreadable"
**Solution**: Make sure you're selecting the `extension` folder, not the `Memori` folder

### Issue: Content script works on one site but not another
**Solution**: Check the URL patterns in manifest.json match the actual URL

### Issue: Extension loads but content script doesn't run
**Solution**: 
- Check browser console for JavaScript errors
- Verify the content script file has no syntax errors
- Try changing `run_at` from `document_idle` to `document_start`

## Still Not Working?

Please provide:
1. Screenshot of `chrome://extensions/` showing the Memori extension
2. Any error messages from Step 1
3. The exact URL you're visiting (from address bar)
4. Chrome version (chrome://version/)
5. Operating system
