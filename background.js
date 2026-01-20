// Background service worker for SN Flow Compare extension

// Track extraction tabs and their requesting tabs
const extractionTabs = new Map(); // tabId -> { requestingTabId, versionSysId, flowSysId }

// Listen for keyboard shortcut command
chrome.commands.onCommand.addListener((command) => {
  if (command === 'compare-flow') {
    // Send message to active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'openCompare' })
          .catch((error) => {
            console.log('SN Flow Compare: Not on a ServiceNow page or content script not loaded');
          });
      }
    });
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getFlowData') {
    // Handle any background data fetching if needed
    sendResponse({ success: true });
    return true;
  }

  // Open a new tab for DOM extraction
  if (message.action === 'openVersionTab') {
    const { url, versionSysId, flowSysId } = message;
    const requestingTabId = sender.tab?.id;

    if (!requestingTabId) {
      sendResponse({ success: false, error: 'No requesting tab ID' });
      return true;
    }

    console.log(`[SN Flow Compare] Opening tab with URL: ${url}`);

    // Create tab (visible for debugging - change active to false for production)
    chrome.tabs.create({
      url: url,
      active: true // Set to true for debugging, false for production
    }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      // Track this extraction tab
      extractionTabs.set(tab.id, {
        requestingTabId,
        versionSysId,
        flowSysId,
        createdAt: Date.now()
      });

      console.log(`[SN Flow Compare] Created extraction tab ${tab.id} for version ${versionSysId}`);
      sendResponse({ success: true, tabId: tab.id });
    });

    return true; // Keep message channel open for async response
  }

  // Forward extracted DOM back to original tab
  if (message.action === 'domExtracted') {
    const extractionTabId = sender.tab?.id;
    const extractionInfo = extractionTabs.get(extractionTabId);

    if (extractionInfo) {
      console.log(`[SN Flow Compare] Forwarding DOM from tab ${extractionTabId} to tab ${extractionInfo.requestingTabId}`);

      // Send DOM data to the requesting tab
      chrome.tabs.sendMessage(extractionInfo.requestingTabId, {
        action: 'domExtracted',
        versionSysId: extractionInfo.versionSysId,
        flowSysId: extractionInfo.flowSysId,
        stepsHtml: message.stepsHtml,
        stepCount: message.stepCount,
        error: message.error,
        debug: message.debug
      }).then(() => {
        // Close the extraction tab after forwarding
        chrome.tabs.remove(extractionTabId).catch(() => {});
        extractionTabs.delete(extractionTabId);
      }).catch((err) => {
        console.error('[SN Flow Compare] Failed to forward DOM:', err);
        extractionTabs.delete(extractionTabId);
      });

      sendResponse({ success: true });
    } else {
      console.warn(`[SN Flow Compare] No extraction info for tab ${extractionTabId}`);
      sendResponse({ success: false, error: 'No extraction info found' });
    }

    return true;
  }

  // Request DOM extraction from an already-open tab
  if (message.action === 'requestExtraction') {
    const { tabId } = message;

    chrome.tabs.sendMessage(tabId, { action: 'extractDOM' })
      .then((response) => {
        sendResponse(response);
      })
      .catch((err) => {
        // Content script might not be loaded, inject it
        injectContentScript(tabId)
          .then(() => {
            // Wait a bit for script to initialize
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { action: 'extractDOM' })
                .then((response) => sendResponse(response))
                .catch((e) => sendResponse({ success: false, error: e.message }));
            }, 500);
          })
          .catch((e) => {
            sendResponse({ success: false, error: e.message });
          });
      });

    return true;
  }

  // Close extraction tab
  if (message.action === 'closeExtractionTab') {
    const { tabId } = message;
    chrome.tabs.remove(tabId).catch(() => {});
    extractionTabs.delete(tabId);
    sendResponse({ success: true });
    return true;
  }

  return true;
});

// Listen for tab updates to detect when Flow Designer has loaded
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const extractionInfo = extractionTabs.get(tabId);

  if (extractionInfo && changeInfo.status === 'complete') {
    console.log(`[SN Flow Compare] Extraction tab ${tabId} finished loading`);

    // Start polling for Flow Designer to be ready
    pollForFlowDesigner(tabId, extractionInfo, 0);
  }
});

// Poll for Flow Designer to load with retries
async function pollForFlowDesigner(tabId, extractionInfo, attempt) {
  const maxAttempts = 20; // More attempts for slow instances
  const delayMs = 3000; // 3 seconds between attempts (total 60s max)

  if (attempt >= maxAttempts) {
    console.error(`[SN Flow Compare] Flow Designer didn't load after ${maxAttempts} attempts`);
    notifyExtractionError(extractionInfo.requestingTabId, extractionInfo.versionSysId, 'Flow Designer did not load in time');
    chrome.tabs.remove(tabId).catch(() => {});
    extractionTabs.delete(tabId);
    return;
  }

  console.log(`[SN Flow Compare] Polling attempt ${attempt + 1}/${maxAttempts} for tab ${tabId}`);

  // Wait before checking
  await new Promise(resolve => setTimeout(resolve, delayMs));

  // Check if tab still exists
  if (!extractionTabs.has(tabId)) {
    console.log(`[SN Flow Compare] Tab ${tabId} no longer tracked, stopping poll`);
    return;
  }

  try {
    // Try to check if Flow Designer is ready
    const response = await chrome.tabs.sendMessage(tabId, { action: 'checkFlowDesignerReady' });

    if (response && response.ready && response.stepCount > 0) {
      console.log(`[SN Flow Compare] Flow Designer ready with ${response.stepCount} steps, extracting...`);
      // Now extract
      chrome.tabs.sendMessage(tabId, { action: 'extractDOM' }).catch(() => {});
    } else {
      console.log(`[SN Flow Compare] Flow Designer not ready yet (ready: ${response?.ready}, steps: ${response?.stepCount})`);
      // Try again
      pollForFlowDesigner(tabId, extractionInfo, attempt + 1);
    }
  } catch (err) {
    console.log(`[SN Flow Compare] Content script not responding, injecting...`);

    try {
      await injectContentScript(tabId);
      // Wait for script to initialize
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Try again
      pollForFlowDesigner(tabId, extractionInfo, attempt + 1);
    } catch (e) {
      console.error(`[SN Flow Compare] Failed to inject script:`, e);
      notifyExtractionError(extractionInfo.requestingTabId, extractionInfo.versionSysId, 'Failed to inject content script');
      chrome.tabs.remove(tabId).catch(() => {});
      extractionTabs.delete(tabId);
    }
  }
}

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  const extractionInfo = extractionTabs.get(tabId);
  if (extractionInfo) {
    console.log(`[SN Flow Compare] Extraction tab ${tabId} was closed`);
    // Notify requesting tab if extraction was incomplete
    notifyExtractionError(extractionInfo.requestingTabId, extractionInfo.versionSysId, 'Extraction tab was closed before completion');
    extractionTabs.delete(tabId);
  }
});

// Inject content script into a tab
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['styles.css']
  });
}

// Notify requesting tab of extraction error
function notifyExtractionError(requestingTabId, versionSysId, errorMessage) {
  chrome.tabs.sendMessage(requestingTabId, {
    action: 'domExtracted',
    versionSysId,
    error: errorMessage
  }).catch(() => {});
}

// Clean up old extraction tabs (older than 90 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [tabId, info] of extractionTabs.entries()) {
    if (now - info.createdAt > 90000) {
      console.log(`[SN Flow Compare] Cleaning up stale extraction tab ${tabId}`);
      chrome.tabs.remove(tabId).catch(() => {});
      notifyExtractionError(info.requestingTabId, info.versionSysId, 'Extraction timed out');
      extractionTabs.delete(tabId);
    }
  }
}, 10000);
