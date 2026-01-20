// Content script for SN Flow Compare extension
// Supports both Flow Designer and Workflow Studio

console.log('[SN Flow Compare] Content script file loaded');

(function() {
  'use strict';

  console.log('[SN Flow Compare] IIFE executing, URL:', window.location.href);

  // Workflow types
  const WORKFLOW_TYPE = {
    FLOW_DESIGNER: 'flow_designer',
    WORKFLOW_STUDIO: 'workflow_studio',
    UNKNOWN: 'unknown'
  };

  // State
  let modal = null;
  let workflowSysId = null;
  let workflowType = WORKFLOW_TYPE.UNKNOWN;
  let versions = [];
  let currentVersionIndex = 0;
  let compareVersionIndex = 1;
  let csrfToken = '';

  // DOM extraction state
  let pendingExtractions = new Map(); // versionSysId -> { resolve, reject, timeout }
  let useDOMExtraction = true; // Feature flag for DOM-based extraction

  // ==========================================
  // HISTORY SIDEBAR INTEGRATION STATE
  // ==========================================

  let historySidebarObserver = null;
  let historyButtonObserver = null;
  let cachedVersionsFromSidebar = [];
  let lastActivatedVersion = null;
  let isHistorySidebarOpen = false;
  let autoCompareInProgress = false;

  // History Sidebar DOM Selectors
  const HISTORY_BUTTON_SELECTOR = 'button[data-tooltip="History"]';
  const SIDEBAR_SELECTOR = '.badged-entry-panel-container';
  const ENTRY_SELECTOR = '.badged-entry-panel-container .entry';
  const ENTRY_TIMESTAMP_SELECTOR = '.entry .top .title';
  const ENTRY_SECTION_HEADER_SELECTOR = '.entry-section-header';
  const STATE_BADGE_SELECTOR = 'now-highlighted-value';

  // Loading overlay reference
  let loadingOverlay = null;

  // ==========================================
  // LOADING OVERLAY & NOTIFICATIONS
  // ==========================================

  function showLoadingOverlay(message = 'Loading...') {
    // Remove existing overlay if any
    hideLoadingOverlay();

    loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'snfc-loading-overlay';
    loadingOverlay.innerHTML = `
      <div class="snfc-loading-panel">
        <div class="snfc-loading-spinner"></div>
        <div class="snfc-loading-message">${escapeHtml(message)}</div>
        <div class="snfc-loading-submessage">Please wait...</div>
      </div>
      <div class="snfc-notification-area"></div>
    `;

    document.body.appendChild(loadingOverlay);

    // Trigger animation
    requestAnimationFrame(() => {
      loadingOverlay.classList.add('snfc-loading-overlay-show');
    });

    return loadingOverlay;
  }

  function updateLoadingMessage(message, submessage = '') {
    if (loadingOverlay) {
      const msgEl = loadingOverlay.querySelector('.snfc-loading-message');
      const subEl = loadingOverlay.querySelector('.snfc-loading-submessage');
      if (msgEl) msgEl.textContent = message;
      if (subEl) subEl.textContent = submessage;
    }
  }

  function hideLoadingOverlay() {
    if (loadingOverlay) {
      loadingOverlay.classList.remove('snfc-loading-overlay-show');
      setTimeout(() => {
        if (loadingOverlay) {
          loadingOverlay.remove();
          loadingOverlay = null;
        }
      }, 300);
    }
  }

  function showNotificationInOverlay(message, type = 'info') {
    const container = loadingOverlay?.querySelector('.snfc-notification-area') || document.body;
    const toast = document.createElement('div');
    toast.className = `snfc-toast snfc-toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('snfc-toast-show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('snfc-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ==========================================
  // DOM EXTRACTION FUNCTIONS
  // ==========================================

  // Flow Designer container selectors
  const FLOW_CONTAINER_SELECTORS = [
    '#app-floweditor',
    '[id*="floweditor"]',
    '[id*="flow-editor"]',
    '.flow-editor',
    '.floweditor'
  ];

  // Step element selectors for different SN versions/configurations
  const STEP_SELECTORS = [
    // ServiceNow Flow Designer specific selectors
    '.instance-component-stage-container',
    '.trigger-section',
    '.actionContainer',
    // Application container children
    'div[role="application"] > div',
    // Common Flow Designer step selectors
    '[data-element-id]',
    '[data-node-id]',
    '[data-step-id]',
    '[data-action-id]',
    '[data-id]',
    // Element type selectors
    '[data-element-type="action"]',
    '[data-element-type="logic"]',
    '[data-element-type="trigger"]',
    '[data-element-type]',
    '[data-type="action"]',
    '[data-type="step"]',
    // Class-based selectors
    '.sn-canvas-node',
    '.sn-fd-step',
    '.fd-node',
    '.flow-node',
    '.step-node',
    '.action-node',
    '.logic-node',
    '.trigger-node',
    // Generic patterns
    '[class*="canvas-node"]',
    '[class*="flow-step"]',
    '[class*="action-node"]',
    '[class*="step-item"]',
    '[class*="flow-action"]',
    // Polaris/newer UI selectors
    '.now-card[data-step]',
    '[data-test-id*="step"]',
    '[data-test-id*="action"]'
  ];

  // Find the Flow Designer container
  function findFlowContainer() {
    for (const selector of FLOW_CONTAINER_SELECTORS) {
      const container = document.querySelector(selector);
      if (container) {
        console.log(`[SN Flow Compare] Found flow container with selector: ${selector}`);
        return container;
      }
    }
    // Fallback to body
    return document.body;
  }

  // Find all step elements in the current page
  function findStepElements() {
    const container = findFlowContainer();
    let elements = [];

    console.log(`[SN Flow Compare] Searching in container:`, container.id || container.tagName);

    // For ServiceNow Flow Designer, collect trigger + steps separately
    const triggers = container.querySelectorAll('.trigger-section');
    const stepContainers = container.querySelectorAll('.instance-component-stage-container');

    console.log(`[SN Flow Compare] Found ${triggers.length} triggers, ${stepContainers.length} step containers`);

    if (triggers.length > 0 || stepContainers.length > 0) {
      elements = [...triggers, ...stepContainers];
      console.log(`[SN Flow Compare] Using SN Flow Designer selectors: ${elements.length} total elements`);
    } else {
      // Fallback: try other selectors
      for (const selector of STEP_SELECTORS) {
        try {
          const found = container.querySelectorAll(selector);
          if (found.length > 0) {
            console.log(`[SN Flow Compare] Found ${found.length} elements with selector: ${selector}`);
            elements = [...found];
            break;
          }
        } catch (e) {
          // Invalid selector, skip
        }
      }
    }

    // If still no elements found, try broader discovery
    if (elements.length === 0) {
      console.log('[SN Flow Compare] No steps found, trying discovery...');
      const candidates = container.querySelectorAll('[class*="container"], [class*="action"], [class*="trigger"], [class*="step"]');
      console.log(`[SN Flow Compare] Discovery found ${candidates.length} candidates`);

      [...candidates].slice(0, 10).forEach((el, i) => {
        console.log(`[SN Flow Compare] Candidate ${i}:`, el.tagName, el.className.substring(0, 100));
      });

      elements = [...candidates];
    }

    // Log what we found before filtering
    console.log(`[SN Flow Compare] Before filtering: ${elements.length} elements`);

    // Don't filter by dimensions - background tabs may not render properly
    // Just filter out obviously wrong elements by class name
    elements = elements.filter(el => {
      const className = el.className || '';
      // Keep trigger-section and instance-component-stage-container always
      if (className.includes('trigger-section') || className.includes('instance-component-stage-container')) {
        return true;
      }
      // Skip elements that are likely not steps
      if (className.includes('tooltip') || className.includes('dropdown') || className.includes('menu')) {
        return false;
      }
      return true;
    });

    console.log(`[SN Flow Compare] After filtering: ${elements.length} step elements`);
    return elements;
  }

  // Extract and clean HTML for a single step element
  function extractStepHTML(element) {
    // Clone the element to avoid modifying the original
    const clone = element.cloneNode(true);

    // Remove session-specific attributes
    const attrsToRemove = [
      'data-session-id',
      'data-instance-id',
      'data-runtime-id',
      'aria-describedby',
      'aria-labelledby'
    ];

    // Clean the clone and all descendants
    const cleanElement = (el) => {
      attrsToRemove.forEach(attr => el.removeAttribute(attr));

      // Remove inline event handlers
      [...el.attributes].forEach(attr => {
        if (attr.name.startsWith('on') || attr.name.startsWith('ng-')) {
          el.removeAttribute(attr.name);
        }
      });

      // Remove Angular/framework-specific classes
      el.classList.forEach(cls => {
        if (cls.startsWith('ng-') || cls.startsWith('cdk-') || cls.includes('focus') || cls.includes('hover')) {
          el.classList.remove(cls);
        }
      });
    };

    cleanElement(clone);
    clone.querySelectorAll('*').forEach(cleanElement);

    // Get position info from original element
    const rect = element.getBoundingClientRect();
    const dataId = element.getAttribute('data-id') || element.id || '';

    // Extract text content for comparison matching
    const textContent = element.textContent?.trim().substring(0, 200) || '';

    return {
      html: clone.outerHTML,
      dataId: dataId,
      textContent: textContent,
      position: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }
    };
  }

  // Extract all steps by opening each one at a time and capturing its content
  async function extractStepsOneByOne(showOverlay = true) {
    const container = findFlowContainer();
    const stepContainers = [...container.querySelectorAll('.instance-component-stage-container')];
    const triggers = [...container.querySelectorAll('.trigger-section')];
    const totalItems = triggers.length + stepContainers.length;

    console.log(`[SN Flow Compare] Extracting ${triggers.length} triggers and ${stepContainers.length} steps one by one...`);

    // Show loading overlay
    if (showOverlay) {
      showLoadingOverlay('Extracting Flow Steps');
      updateLoadingMessage('Extracting Flow Steps', `Found ${totalItems} items to process...`);
    }

    const extractedSteps = [];
    let processedCount = 0;

    // Extract triggers first - click on name to open
    for (const trigger of triggers) {
      try {
        processedCount++;
        if (showOverlay) {
          updateLoadingMessage('Extracting Flow Steps', `Processing trigger ${processedCount} of ${totalItems}...`);
        }

        // Find and click the trigger name/title to open it
        const triggerName = trigger.querySelector('.trigger-name, .trigger-title, [class*="name"], [class*="title"], .header, h3, h4, span');
        if (triggerName) {
          triggerName.click();
          await new Promise(resolve => setTimeout(resolve, 400));
        }

        const stepData = extractStepHTML(trigger);
        stepData.order = extractedSteps.length + 1;
        extractedSteps.push(stepData);
      } catch (e) {
        console.log('[SN Flow Compare] Could not extract trigger:', e);
      }
    }

    // Extract each step by clicking on its name to open it
    for (let i = 0; i < stepContainers.length; i++) {
      const step = stepContainers[i];
      processedCount++;

      try {
        console.log(`[SN Flow Compare] Processing step ${i + 1}/${stepContainers.length}...`);

        if (showOverlay) {
          updateLoadingMessage('Extracting Flow Steps', `Opening step ${i + 1} of ${stepContainers.length}...`);
        }

        // Find the instanceOpener element to click and open the step
        const instanceOpener = step.querySelector('.instanceOpener');

        // Scroll step into view first
        step.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 200));

        if (instanceOpener) {
          console.log(`[SN Flow Compare] Clicking instanceOpener for step ${i + 1}`);
          instanceOpener.scrollIntoView({ behavior: 'instant', block: 'center' });
          instanceOpener.click();
          instanceOpener.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } else {
          // Fallback: click the step container itself
          console.log(`[SN Flow Compare] No instanceOpener found, clicking container`);
          step.click();
          step.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }

        // Wait for the step panel to open and render (longer wait)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Extract the step container HTML
        const stepData = extractStepHTML(step);

        // Also look for any open details panel and capture its content
        const detailsPanel = document.querySelector(
          '.properties-panel, .step-details, .action-details, .component-details, ' +
          '[class*="properties-panel"], [class*="detail-panel"], [class*="config-panel"], ' +
          '.side-panel-content, .editor-panel, [class*="editor-panel"]'
        );

        if (detailsPanel) {
          // Append the details panel content to the step HTML
          const panelClone = detailsPanel.cloneNode(true);
          stepData.html += '<div class="snfc-details-panel">' + panelClone.innerHTML + '</div>';
          stepData.detailsHtml = panelClone.innerHTML;
          console.log(`[SN Flow Compare] Captured details panel for step ${i + 1}`);
        }

        stepData.order = extractedSteps.length + 1;
        extractedSteps.push(stepData);

        console.log(`[SN Flow Compare] Extracted step ${i + 1}/${stepContainers.length}: ${stepData.name || 'unnamed'}`);

        // Small delay before clicking next step
        await new Promise(resolve => setTimeout(resolve, 300));

      } catch (e) {
        console.log('[SN Flow Compare] Could not extract step:', e);
      }
    }

    // Filter out invalid steps
    const validSteps = extractedSteps.filter(step => {
      if (!step.html || step.html.length < 50) return false;
      if (step.textContent && step.textContent.toLowerCase().includes('help') && step.textContent.length < 20) return false;
      if (step.textContent && step.textContent.length < 5) return false;
      return true;
    });

    // Re-number
    validSteps.forEach((step, idx) => {
      step.order = idx + 1;
    });

    console.log(`[SN Flow Compare] Extracted ${validSteps.length} valid steps`);

    // Hide loading overlay
    if (showOverlay) {
      hideLoadingOverlay();
    }

    return { steps: validSteps, error: null };
  }

  // Extract all steps from current page (non-async version for compatibility)
  function extractAllStepsHTML() {
    const elements = findStepElements();

    if (elements.length === 0) {
      console.log('[SN Flow Compare] No step elements found');
      return { steps: [], error: null };
    }

    // Sort elements by position (top to bottom, left to right)
    const sortedElements = [...elements].sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      const yDiff = rectA.top - rectB.top;
      if (Math.abs(yDiff) > 30) return yDiff;
      return rectA.left - rectB.left;
    });

    const steps = sortedElements.map((el, index) => ({
      order: index + 1,
      ...extractStepHTML(el)
    }));

    // Filter out invalid steps (empty content, help elements, etc.)
    const validSteps = steps.filter(step => {
      // Skip steps with no meaningful content
      if (!step.html || step.html.length < 50) return false;

      // Skip help/tooltip elements
      if (step.textContent.toLowerCase().includes('help') && step.textContent.length < 20) return false;

      // Skip elements that are just IDs or very short text
      if (step.textContent.length < 5) return false;

      return true;
    });

    // Re-number the steps
    validSteps.forEach((step, idx) => {
      step.order = idx + 1;
    });

    console.log(`[SN Flow Compare] Extracted ${validSteps.length} valid steps (filtered from ${steps.length})`);
    return { steps: validSteps, error: null };
  }

  // Build Flow Designer URL for a specific version
  function buildFlowDesignerUrl(flowSysId, versionSysId) {
    const baseUrl = getBaseUrl();

    // Try to detect the URL pattern from the current page
    const currentUrl = window.location.href;

    // Try multiple URL patterns
    const patterns = [];

    if (currentUrl.includes('/now/workflow-studio/builder')) {
      // New Workflow Studio - try different version parameter names
      patterns.push(`${baseUrl}/now/workflow-studio/builder?table=sys_hub_flow&sysId=${flowSysId}&version=${versionSysId}`);
      patterns.push(`${baseUrl}/now/workflow-studio/builder?table=sys_hub_flow_version&sysId=${versionSysId}`);
      patterns.push(`${baseUrl}/now/workflow-studio/builder?table=sys_hub_flow&sysId=${flowSysId}`);
    } else {
      // Legacy Flow Designer
      patterns.push(`${baseUrl}/$flow-designer.do#/flow-designer/${flowSysId}/version/${versionSysId}`);
    }

    // For now, try opening just the flow (we'll handle version switching differently)
    // TODO: Find correct URL pattern for specific versions
    console.log(`[SN Flow Compare] Attempting URL patterns:`, patterns);

    // Use the simplest working pattern for now
    if (currentUrl.includes('/now/workflow-studio/builder')) {
      return `${baseUrl}/now/workflow-studio/builder?table=sys_hub_flow&sysId=${flowSysId}`;
    } else {
      return `${baseUrl}/$flow-designer.do#/flow-designer/${flowSysId}/version/${versionSysId}`;
    }
  }

  // Extract DOM from another version by opening it in a background tab
  function extractDOMFromVersion(versionSysId, flowSysId) {
    return new Promise((resolve, reject) => {
      if (!flowSysId) {
        console.error('[SN Flow Compare] No flowSysId provided for version', versionSysId);
        reject(new Error('No flow ID available for this version'));
        return;
      }

      const url = buildFlowDesignerUrl(flowSysId, versionSysId);
      console.log(`[SN Flow Compare] Requesting DOM extraction for version ${versionSysId}`);
      console.log(`[SN Flow Compare] Flow ID: ${flowSysId}`);
      console.log(`[SN Flow Compare] URL: ${url}`);

      // Set up timeout (90 seconds for slow instances)
      const timeout = setTimeout(() => {
        pendingExtractions.delete(versionSysId);
        reject(new Error('DOM extraction timed out after 90 seconds'));
      }, 90000);

      // Store pending extraction
      pendingExtractions.set(versionSysId, { resolve, reject, timeout });

      // Request background script to open tab
      chrome.runtime.sendMessage({
        action: 'openVersionTab',
        url: url,
        versionSysId: versionSysId,
        flowSysId: flowSysId
      }, (response) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          pendingExtractions.delete(versionSysId);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.success) {
          clearTimeout(timeout);
          pendingExtractions.delete(versionSysId);
          reject(new Error(response?.error || 'Failed to open version tab'));
        }
        // Otherwise wait for domExtracted message
      });
    });
  }

  // Check if current page is showing a specific flow version
  function getCurrentVersionFromPage() {
    const url = window.location.href;

    // Try different URL patterns

    // Pattern 1: /version/{versionSysId} (legacy)
    const versionMatch = url.match(/\/version\/([a-f0-9]{32})/i);
    if (versionMatch) {
      return versionMatch[1];
    }

    // Pattern 2: versionId={versionSysId} (query param)
    const versionIdMatch = url.match(/[?&]versionId=([a-f0-9]{32})/i);
    if (versionIdMatch) {
      return versionIdMatch[1];
    }

    // Pattern 3: version={versionSysId} (query param)
    const versionParamMatch = url.match(/[?&]version=([a-f0-9]{32})/i);
    if (versionParamMatch) {
      return versionParamMatch[1];
    }

    // No version in URL - might be viewing current/draft version
    return null;
  }

  // Get CSRF token from ServiceNow page
  function getCSRFToken() {
    // Try to get g_ck from the page by injecting a script
    return new Promise((resolve) => {
      // First check if we already have it
      if (csrfToken) {
        resolve(csrfToken);
        return;
      }

      // Create a script to extract g_ck from page context
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          var token = window.g_ck || '';
          if (!token) {
            // Try to find it in cookies
            var match = document.cookie.match(/g_ck=([^;]+)/);
            if (match) token = match[1];
          }
          // Also try glide_session_token
          if (!token && window.g_session_token) token = window.g_session_token;

          document.body.setAttribute('data-snfc-token', token);
        })();
      `;
      document.body.appendChild(script);
      script.remove();

      // Read the token from the attribute
      csrfToken = document.body.getAttribute('data-snfc-token') || '';
      document.body.removeAttribute('data-snfc-token');

      resolve(csrfToken);
    });
  }

  // Make authenticated fetch request
  async function snFetch(url) {
    const token = await getCSRFToken();

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    if (token) {
      headers['X-UserToken'] = token;
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'include'
      });

      if (!response.ok) {
        // Don't throw for 401 on discovery queries - just return empty
        if (response.status === 401 || response.status === 403) {
          return { result: [] };
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    } catch (e) {
      throw e;
    }
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'openCompare') {
      openCompareModal();
      sendResponse({ success: true });
      return true;
    }

    // Check if Flow Designer is ready (has loaded steps)
    if (message.action === 'checkFlowDesignerReady') {
      const container = document.querySelector('#app-floweditor');
      if (!container) {
        sendResponse({ ready: false, stepCount: 0, reason: 'no container' });
        return true;
      }

      const triggers = container.querySelectorAll('.trigger-section');
      const steps = container.querySelectorAll('.instance-component-stage-container');
      const totalSteps = triggers.length + steps.length;

      console.log(`[SN Flow Compare] checkFlowDesignerReady: triggers=${triggers.length}, steps=${steps.length}`);

      sendResponse({
        ready: totalSteps > 0,
        stepCount: totalSteps,
        containerFound: true
      });
      return true;
    }

    // Handle DOM extraction request (when this page is opened for extraction)
    if (message.action === 'extractDOM') {
      console.log('[SN Flow Compare] Received extractDOM request');
      console.log('[SN Flow Compare] Current URL:', window.location.href);

      // Check if Flow Designer container exists
      const container = document.querySelector('#app-floweditor');
      console.log('[SN Flow Compare] #app-floweditor exists:', !!container);

      if (container) {
        console.log('[SN Flow Compare] Container innerHTML length:', container.innerHTML.length);
        const triggers = container.querySelectorAll('.trigger-section');
        const steps = container.querySelectorAll('.instance-component-stage-container');
        console.log('[SN Flow Compare] Direct query - triggers:', triggers.length, 'steps:', steps.length);
      }

      // Extract steps from the current page
      const result = extractAllStepsHTML();
      console.log('[SN Flow Compare] Extraction result:', result.steps.length, 'steps');

      // Send result back to background script
      chrome.runtime.sendMessage({
        action: 'domExtracted',
        stepsHtml: result.steps,
        stepCount: result.steps.length,
        error: result.error,
        debug: {
          url: window.location.href,
          containerFound: !!container,
          containerSize: container ? container.innerHTML.length : 0
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[SN Flow Compare] Failed to send extracted DOM:', chrome.runtime.lastError);
        }
      });

      sendResponse({ success: true, stepCount: result.steps.length });
      return true;
    }

    // Handle DOM extracted response (forwarded from extraction tab)
    if (message.action === 'domExtracted') {
      console.log(`[SN Flow Compare] Received domExtracted for version ${message.versionSysId}`);
      console.log(`[SN Flow Compare] Step count: ${message.stepCount}, Error: ${message.error}`);
      if (message.debug) {
        console.log(`[SN Flow Compare] Debug info:`, message.debug);
      }

      const pending = pendingExtractions.get(message.versionSysId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingExtractions.delete(message.versionSysId);

        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve({
            steps: message.stepsHtml || [],
            stepCount: message.stepCount || 0
          });
        }
      } else {
        console.warn(`[SN Flow Compare] No pending extraction for version ${message.versionSysId}`);
      }

      sendResponse({ success: true });
      return true;
    }

    return true;
  });

  // Detect workflow type from URL/page
  function detectWorkflowType() {
    const url = window.location.href.toLowerCase();


    // Flow Designer detection
    if (url.includes('flow_designer.do') ||
        url.includes('$flow-designer') ||
        url.includes('/now/workflow/') ||
        url.includes('/now/nav/ui/classic/params/target/sys_hub_flow') ||
        url.includes('sys_hub_flow') ||
        document.querySelector('[data-component-id="flow-designer"]') !== null) {
      return WORKFLOW_TYPE.FLOW_DESIGNER;
    }

    // Workflow Studio detection - expanded patterns
    if (url.includes('workflow_ide.do') ||
        url.includes('wf_workflow.do') ||
        url.includes('workflow_version.do') ||
        url.includes('wf_workflow_version') ||
        url.includes('/nav_to.do?uri=wf_workflow') ||
        url.includes('sys_class_name=wf_workflow') ||
        url.includes('table=wf_workflow') ||
        url.includes('sysparm_table=wf_workflow') ||
        url.includes('/now/nav/ui/classic/params/target/wf_workflow') ||
        document.querySelector('.workflow-editor, #workflow_canvas, .wf-canvas, #wf_workflow') !== null) {
      return WORKFLOW_TYPE.WORKFLOW_STUDIO;
    }

    // Check page title or other indicators
    const pageTitle = document.title.toLowerCase();

    if (pageTitle.includes('flow designer') || pageTitle.includes('flow:')) {
      return WORKFLOW_TYPE.FLOW_DESIGNER;
    }
    if (pageTitle.includes('workflow editor') || pageTitle.includes('workflow:') || pageTitle.includes('workflow |')) {
      return WORKFLOW_TYPE.WORKFLOW_STUDIO;
    }

    // Check for iframe - might be inside ServiceNow's frame structure
    if (window.parent !== window) {
      try {
        const parentUrl = window.parent.location.href.toLowerCase();
        if (parentUrl.includes('wf_workflow') || parentUrl.includes('workflow')) {
          return WORKFLOW_TYPE.WORKFLOW_STUDIO;
        }
      } catch (e) {
        // Cross-origin, can't access parent
      }
    }

    return WORKFLOW_TYPE.UNKNOWN;
  }

  // Check if we're on a supported workflow page
  function isWorkflowPage() {
    return detectWorkflowType() !== WORKFLOW_TYPE.UNKNOWN;
  }

  // Extract workflow sys_id from URL or page
  function extractWorkflowSysId() {

    let sysId = null;

    // Try URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    sysId = urlParams.get('sys_id') || urlParams.get('sysparm_sys_id');
    if (sysId) {
      return sysId;
    }

    // Try hash path (e.g., #/flow-designer/e3f5a56383daf2500e5cc1ffeeaad3c5)
    if (window.location.hash) {
      // Match 32-character hex string in hash
      const hashPathMatch = window.location.hash.match(/\/([a-f0-9]{32})(?:\/|$|\?)/i);
      if (hashPathMatch) {
        sysId = hashPathMatch[1];
        return sysId;
      }

      // Try hash query parameters
      const hashMatch = window.location.hash.match(/[?&]sys_id=([a-f0-9]{32})/i);
      if (hashMatch) {
        sysId = hashMatch[1];
        return sysId;
      }

      // Try parsing hash as query string
      const hashPart = window.location.hash.includes('?')
        ? window.location.hash.split('?')[1]
        : window.location.hash.slice(1);
      const hashParams = new URLSearchParams(hashPart);
      sysId = hashParams.get('sys_id') || hashParams.get('flow');
      if (sysId) {
        return sysId;
      }
    }

    // Try to extract from full URL - any 32-char hex after flow-related keywords
    const pathMatch = window.location.href.match(/(?:flow-designer|flow|wf_workflow|workflow)[\/=]([a-f0-9]{32})/i);
    if (pathMatch) {
      sysId = pathMatch[1];
      return sysId;
    }

    // Try to find in page content
    const element = document.querySelector('[data-flow-id], [data-sys-id], [data-workflow-id], #sys_uniqueValue, input[name="sys_uniqueValue"]');
    if (element) {
      sysId = element.dataset?.flowId || element.dataset?.sysId || element.dataset?.workflowId || element.value;
      if (sysId) {
        return sysId;
      }
    }

    // Try g_form if available (ServiceNow global)
    if (typeof g_form !== 'undefined') {
      try {
        sysId = g_form.getUniqueValue();
        if (sysId) {
          return sysId;
        }
      } catch (e) {}
    }

    return null;
  }

  // Get instance base URL
  function getBaseUrl() {
    return `${window.location.protocol}//${window.location.host}`;
  }

  // ==========================================
  // COMPARISON LOGIC
  // ==========================================

  function parseJson(str) {
    if (!str) return {};
    try {
      return typeof str === 'string' ? JSON.parse(str) : str;
    } catch {
      return {};
    }
  }

  function compareSteps(step1, step2) {
    const diffs = [];

    if (step1.name !== step2.name) {
      diffs.push({ field: 'name', old: step1.name, new: step2.name });
    }

    if (step1.stepType !== step2.stepType) {
      diffs.push({ field: 'type', old: step1.stepType, new: step2.stepType });
    }

    if (step1.condition !== step2.condition) {
      diffs.push({ field: 'condition', old: step1.condition, new: step2.condition });
    }

    const inputs1 = parseJson(step1.inputs);
    const inputs2 = parseJson(step2.inputs);

    const allInputKeys = new Set([...Object.keys(inputs1), ...Object.keys(inputs2)]);
    for (const key of allInputKeys) {
      if (JSON.stringify(inputs1[key]) !== JSON.stringify(inputs2[key])) {
        diffs.push({
          field: `input.${key}`,
          old: inputs1[key],
          new: inputs2[key]
        });
      }
    }

    return diffs;
  }

  function generateDiff(stepsLeft, stepsRight) {
    const result = {
      left: [],
      right: [],
      summary: { added: 0, removed: 0, modified: 0, unchanged: 0 }
    };

    const leftMap = new Map(stepsLeft.map(s => [s.sys_id, s]));
    const rightMap = new Map(stepsRight.map(s => [s.sys_id, s]));
    const leftByName = new Map(stepsLeft.map(s => [s.name, s]));
    const rightByName = new Map(stepsRight.map(s => [s.name, s]));

    for (const step of stepsLeft) {
      let match = rightMap.get(step.sys_id) || rightByName.get(step.name);

      if (match) {
        const diffs = compareSteps(step, match);
        if (diffs.length > 0) {
          result.left.push({ ...step, status: 'modified', diffs });
          result.summary.modified++;
        } else {
          result.left.push({ ...step, status: 'unchanged' });
          result.summary.unchanged++;
        }
      } else {
        result.left.push({ ...step, status: 'removed' });
        result.summary.removed++;
      }
    }

    for (const step of stepsRight) {
      let match = leftMap.get(step.sys_id) || leftByName.get(step.name);

      if (match) {
        const diffs = compareSteps(match, step);
        if (diffs.length > 0) {
          result.right.push({ ...step, status: 'modified', diffs });
        } else {
          result.right.push({ ...step, status: 'unchanged' });
        }
      } else {
        result.right.push({ ...step, status: 'added' });
        result.summary.added++;
      }
    }

    return result;
  }

  // ==========================================
  // UI RENDERING
  // ==========================================

  function renderStep(step, side) {
    const statusClass = step.status || 'unchanged';
    const typeIcon = step.type === 'logic' ? '⟁' : step.type === 'activity' ? '◆' : '▸';

    let diffsHtml = '';
    if (step.diffs && step.diffs.length > 0) {
      diffsHtml = `
        <div class="snfc-step-diffs">
          ${step.diffs.map(d => {
            // Show only the relevant value for each side: left=old (red), right=new (green)
            const fieldLabel = formatInputLabel(d.field);
            if (side === 'left' && d.old !== undefined) {
              const formattedValue = formatDiffValue(d.old, escapeHtml, 'old');
              return `
                <div class="snfc-diff-item snfc-diff-item-old">
                  <span class="snfc-diff-field">${escapeHtml(fieldLabel)}:</span>
                  <div class="snfc-diff-value snfc-diff-old">${formattedValue}</div>
                </div>
              `;
            } else if (side === 'right' && d.new !== undefined) {
              const formattedValue = formatDiffValue(d.new, escapeHtml, 'new');
              return `
                <div class="snfc-diff-item snfc-diff-item-new">
                  <span class="snfc-diff-field">${escapeHtml(fieldLabel)}:</span>
                  <div class="snfc-diff-value snfc-diff-new">${formattedValue}</div>
                </div>
              `;
            }
            return '';
          }).filter(Boolean).join('')}
        </div>
      `;
    }

    const inputs = parseJson(step.inputs);
    // Filter out internal/system fields and empty values
    const filteredInputs = Object.entries(inputs).filter(([key, value]) => {
      // Skip internal fields
      if (key.startsWith('sys_') || key === 'order' || key === 'active') return false;
      // Skip empty values
      if (value === null || value === undefined || value === '') return false;
      // Skip sys_id-only values (32 char hex strings with no display value)
      if (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)) return false;
      return true;
    });

    const inputsHtml = filteredInputs.length > 0 ? `
      <div class="snfc-step-inputs">
        <div class="snfc-inputs-label">Inputs:</div>
        ${filteredInputs.map(([key, value]) => {
          const displayLabel = formatInputLabel(key);
          const displayValue = formatInputValue(value, escapeHtml);
          return `
            <div class="snfc-input-item">
              <span class="snfc-input-key">${escapeHtml(displayLabel)}:</span>
              <span class="snfc-input-value">${displayValue}</span>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    const conditionHtml = step.condition ? `
      <div class="snfc-step-condition">
        <span class="snfc-condition-label">Condition:</span>
        <span class="snfc-condition-value">${escapeHtml(String(step.condition).slice(0, 100))}</span>
      </div>
    ` : '';

    // Step label uses the name resolved upstream (now consistent with Flow Designer display)
    const stepLabel = step.name || step.stepType || step.logic_type || 'Unnamed Step';
    const orderDisplay = step.order !== undefined && step.order !== null ? step.order : '?';

    // For step type badge: show action type (like "Update Record") or logic type (like "If")
    const stepTypeBadge = step.action || step.logic_type || step.stepType || step.type || '';

    return `
      <div class="snfc-step snfc-step-${statusClass}" data-sys-id="${step.sys_id}">
        <div class="snfc-step-header">
          <span class="snfc-step-order-badge">${orderDisplay}</span>
          <span class="snfc-step-icon">${typeIcon}</span>
          <span class="snfc-step-name">${escapeHtml(stepLabel)}</span>
          ${stepTypeBadge ? `<span class="snfc-step-type">${escapeHtml(stepTypeBadge)}</span>` : ''}
          <span class="snfc-step-status">${statusClass}</span>
        </div>
        <div class="snfc-step-details">
          ${conditionHtml}
          ${inputsHtml}
          ${diffsHtml}
        </div>
      </div>
    `;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Convert snake_case or camelCase to Title Case for human readability
  function formatInputLabel(key) {
    return key
      // Insert space before uppercase letters (for camelCase)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Replace underscores and hyphens with spaces
      .replace(/[_-]/g, ' ')
      // Capitalize first letter of each word
      .replace(/\b\w/g, c => c.toUpperCase())
      // Fix common abbreviations
      .replace(/\bId\b/g, 'ID')
      .replace(/\bUrl\b/g, 'URL')
      .replace(/\bApi\b/g, 'API')
      .replace(/\bSys\b/g, 'Sys');
  }

  // Format a primitive value for display
  function formatPrimitiveValue(value, escapeHtmlFn) {
    if (value === null || value === undefined) {
      return '<em class="snfc-input-empty">empty</em>';
    }
    if (typeof value === 'boolean') {
      return value ? '<span class="snfc-input-bool snfc-input-true">Yes</span>' : '<span class="snfc-input-bool snfc-input-false">No</span>';
    }
    if (typeof value === 'string') {
      if (/^[a-f0-9]{32}$/.test(value)) {
        return '<em class="snfc-input-empty">reference</em>';
      }
      if (value.includes('\n') || value.length > 100) {
        return `<pre class="snfc-input-multiline">${escapeHtmlFn(value)}</pre>`;
      }
    }
    return escapeHtmlFn(String(value));
  }

  // Format an object as a readable nested list
  function formatObjectAsHtml(obj, escapeHtmlFn, depth = 0) {
    if (depth > 3) {
      // Prevent too deep nesting
      return `<span class="snfc-input-value">${escapeHtmlFn(JSON.stringify(obj))}</span>`;
    }

    const entries = Object.entries(obj).filter(([k, v]) => {
      // Skip sys_id-like values
      if (typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)) return false;
      // Skip null/undefined/empty
      if (v === null || v === undefined || v === '') return false;
      return true;
    });

    if (entries.length === 0) {
      return '<em class="snfc-input-empty">empty</em>';
    }

    const items = entries.map(([key, val]) => {
      const label = formatInputLabel(key);
      let valueHtml;

      if (val && typeof val === 'object' && !Array.isArray(val)) {
        // Check for ServiceNow reference format
        if (val.display_value !== undefined && val.display_value !== '') {
          valueHtml = escapeHtmlFn(String(val.display_value));
        } else if (val.value !== undefined && !/^[a-f0-9]{32}$/.test(val.value)) {
          valueHtml = escapeHtmlFn(String(val.value));
        } else if (val.name !== undefined) {
          valueHtml = escapeHtmlFn(String(val.name));
        } else {
          // Nested object - recurse
          valueHtml = formatObjectAsHtml(val, escapeHtmlFn, depth + 1);
        }
      } else if (Array.isArray(val)) {
        // Format arrays
        if (val.length === 0) {
          valueHtml = '<em class="snfc-input-empty">empty list</em>';
        } else {
          const arrayItems = val.map((item, idx) => {
            if (item && typeof item === 'object') {
              return `<div class="snfc-input-array-item"><span class="snfc-input-array-index">${idx + 1}.</span>${formatObjectAsHtml(item, escapeHtmlFn, depth + 1)}</div>`;
            } else {
              return `<div class="snfc-input-array-item"><span class="snfc-input-array-index">${idx + 1}.</span><span class="snfc-input-value">${formatPrimitiveValue(item, escapeHtmlFn)}</span></div>`;
            }
          }).join('');
          valueHtml = `<div class="snfc-input-array">${arrayItems}</div>`;
        }
      } else {
        valueHtml = formatPrimitiveValue(val, escapeHtmlFn);
      }

      return `<div class="snfc-input-nested-item"><span class="snfc-input-nested-key">${escapeHtmlFn(label)}:</span><span class="snfc-input-nested-value">${valueHtml}</span></div>`;
    }).join('');

    return `<div class="snfc-input-nested">${items}</div>`;
  }

  // Format a value for human-readable display
  function formatInputValue(value, escapeHtmlFn) {
    if (value === null || value === undefined) {
      return '<em class="snfc-input-empty">empty</em>';
    }

    if (typeof value === 'boolean') {
      return value ? '<span class="snfc-input-bool snfc-input-true">Yes</span>' : '<span class="snfc-input-bool snfc-input-false">No</span>';
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return '<em class="snfc-input-empty">empty list</em>';
      }
      const arrayItems = value.map((item, idx) => {
        if (item && typeof item === 'object') {
          return `<div class="snfc-input-array-item"><span class="snfc-input-array-index">${idx + 1}.</span>${formatObjectAsHtml(item, escapeHtmlFn, 1)}</div>`;
        } else {
          return `<div class="snfc-input-array-item"><span class="snfc-input-array-index">${idx + 1}.</span><span class="snfc-input-value">${formatPrimitiveValue(item, escapeHtmlFn)}</span></div>`;
        }
      }).join('');
      return `<div class="snfc-input-array">${arrayItems}</div>`;
    }

    if (typeof value === 'object') {
      // Check for ServiceNow reference format {value, display_value}
      if (value.display_value !== undefined && value.display_value !== '') {
        return escapeHtmlFn(String(value.display_value));
      } else if (value.value !== undefined && !/^[a-f0-9]{32}$/.test(value.value)) {
        return escapeHtmlFn(String(value.value));
      } else if (value.name !== undefined) {
        return escapeHtmlFn(String(value.name));
      } else {
        // Format as readable nested structure
        return formatObjectAsHtml(value, escapeHtmlFn, 0);
      }
    }

    if (typeof value === 'string') {
      if (/^[a-f0-9]{32}$/.test(value)) {
        return '<em class="snfc-input-empty">reference</em>';
      }
      // Handle multiline strings or long values
      if (value.includes('\n') || value.length > 100) {
        return `<pre class="snfc-input-multiline">${escapeHtmlFn(value)}</pre>`;
      }
    }

    return escapeHtmlFn(String(value));
  }

  // Format a diff value with appropriate styling (old=red, new=green)
  function formatDiffValue(value, escapeHtmlFn, type) {
    const colorClass = type === 'old' ? 'snfc-diff-text-old' : 'snfc-diff-text-new';

    if (value === null || value === undefined) {
      return `<em class="${colorClass}">empty</em>`;
    }

    if (typeof value === 'boolean') {
      return `<span class="${colorClass}">${value ? 'Yes' : 'No'}</span>`;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return `<em class="${colorClass}">empty list</em>`;
      }
      return formatDiffObjectAsHtml(value, escapeHtmlFn, colorClass, 0);
    }

    if (typeof value === 'object') {
      // Check for ServiceNow reference format
      if (value.display_value !== undefined && value.display_value !== '') {
        return `<span class="${colorClass}">${escapeHtmlFn(String(value.display_value))}</span>`;
      } else if (value.value !== undefined && !/^[a-f0-9]{32}$/.test(value.value)) {
        return `<span class="${colorClass}">${escapeHtmlFn(String(value.value))}</span>`;
      } else if (value.name !== undefined) {
        return `<span class="${colorClass}">${escapeHtmlFn(String(value.name))}</span>`;
      } else {
        return formatDiffObjectAsHtml(value, escapeHtmlFn, colorClass, 0);
      }
    }

    if (typeof value === 'string') {
      if (/^[a-f0-9]{32}$/.test(value)) {
        return `<em class="${colorClass}">reference</em>`;
      }
      if (value.includes('\n') || value.length > 100) {
        return `<pre class="snfc-diff-multiline ${colorClass}">${escapeHtmlFn(value)}</pre>`;
      }
    }

    return `<span class="${colorClass}">${escapeHtmlFn(String(value))}</span>`;
  }

  // Format an object for diff display with color
  function formatDiffObjectAsHtml(obj, escapeHtmlFn, colorClass, depth) {
    if (depth > 3) {
      return `<span class="${colorClass}">${escapeHtmlFn(JSON.stringify(obj))}</span>`;
    }

    const isArray = Array.isArray(obj);
    const entries = isArray
      ? obj.map((v, i) => [i, v])
      : Object.entries(obj).filter(([k, v]) => {
          if (typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)) return false;
          if (v === null || v === undefined || v === '') return false;
          return true;
        });

    if (entries.length === 0) {
      return `<em class="${colorClass}">empty</em>`;
    }

    const items = entries.map(([key, val]) => {
      const label = isArray ? `${Number(key) + 1}.` : formatInputLabel(String(key));
      let valueHtml;

      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (val.display_value !== undefined && val.display_value !== '') {
          valueHtml = `<span class="${colorClass}">${escapeHtmlFn(String(val.display_value))}</span>`;
        } else if (val.value !== undefined && !/^[a-f0-9]{32}$/.test(val.value)) {
          valueHtml = `<span class="${colorClass}">${escapeHtmlFn(String(val.value))}</span>`;
        } else if (val.name !== undefined) {
          valueHtml = `<span class="${colorClass}">${escapeHtmlFn(String(val.name))}</span>`;
        } else {
          valueHtml = formatDiffObjectAsHtml(val, escapeHtmlFn, colorClass, depth + 1);
        }
      } else if (Array.isArray(val)) {
        valueHtml = formatDiffObjectAsHtml(val, escapeHtmlFn, colorClass, depth + 1);
      } else if (typeof val === 'boolean') {
        valueHtml = `<span class="${colorClass}">${val ? 'Yes' : 'No'}</span>`;
      } else if (val === null || val === undefined) {
        valueHtml = `<em class="${colorClass}">empty</em>`;
      } else if (typeof val === 'string' && /^[a-f0-9]{32}$/.test(val)) {
        valueHtml = `<em class="${colorClass}">reference</em>`;
      } else {
        valueHtml = `<span class="${colorClass}">${escapeHtmlFn(String(val))}</span>`;
      }

      const keyClass = isArray ? 'snfc-diff-array-index' : 'snfc-diff-nested-key';
      return `<div class="snfc-diff-nested-item"><span class="${keyClass}">${isArray ? label : escapeHtmlFn(label) + ':'}</span><span class="snfc-diff-nested-value">${valueHtml}</span></div>`;
    }).join('');

    return `<div class="snfc-diff-nested">${items}</div>`;
  }

  function getWorkflowTypeLabel(type) {
    return type === WORKFLOW_TYPE.FLOW_DESIGNER ? 'Flow Designer' : 'Workflow Studio';
  }

  // ==========================================
  // DOM-BASED COMPARISON RENDERING
  // ==========================================

  // Compare two extracted step arrays and generate diff
  function compareExtractedSteps(leftSteps, rightSteps) {
    const result = {
      left: [],
      right: [],
      summary: { added: 0, removed: 0, modified: 0, unchanged: 0 }
    };

    // Match steps by dataId or textContent
    const leftByDataId = new Map();
    const leftByText = new Map();
    leftSteps.forEach((step, idx) => {
      if (step.dataId) leftByDataId.set(step.dataId, { step, idx });
      if (step.textContent) leftByText.set(step.textContent.substring(0, 50), { step, idx });
    });

    const rightByDataId = new Map();
    const rightByText = new Map();
    rightSteps.forEach((step, idx) => {
      if (step.dataId) rightByDataId.set(step.dataId, { step, idx });
      if (step.textContent) rightByText.set(step.textContent.substring(0, 50), { step, idx });
    });

    const matchedRightIndices = new Set();

    // Process left steps
    leftSteps.forEach((leftStep, leftIdx) => {
      // Try to find matching right step
      let match = null;
      let matchIdx = -1;

      // Try by dataId first
      if (leftStep.dataId && rightByDataId.has(leftStep.dataId)) {
        const found = rightByDataId.get(leftStep.dataId);
        match = found.step;
        matchIdx = found.idx;
      }
      // Then try by textContent
      else if (leftStep.textContent) {
        const key = leftStep.textContent.substring(0, 50);
        if (rightByText.has(key)) {
          const found = rightByText.get(key);
          if (!matchedRightIndices.has(found.idx)) {
            match = found.step;
            matchIdx = found.idx;
          }
        }
      }

      if (match && matchIdx >= 0) {
        matchedRightIndices.add(matchIdx);

        // Compare HTML content
        const htmlDiff = leftStep.html !== match.html;
        if (htmlDiff) {
          result.left.push({ ...leftStep, status: 'modified', matchIdx });
          result.summary.modified++;
        } else {
          result.left.push({ ...leftStep, status: 'unchanged', matchIdx });
          result.summary.unchanged++;
        }
      } else {
        result.left.push({ ...leftStep, status: 'removed' });
        result.summary.removed++;
      }
    });

    // Process right steps
    rightSteps.forEach((rightStep, rightIdx) => {
      const matchInfo = result.left.find(l => l.matchIdx === rightIdx);

      if (matchInfo) {
        // This step was matched
        result.right.push({ ...rightStep, status: matchInfo.status });
      } else {
        // This is a new step (added)
        result.right.push({ ...rightStep, status: 'added' });
        result.summary.added++;
      }
    });

    return result;
  }

  // Render extracted HTML for a step using iframe to preserve SN styles
  function renderExtractedStep(step, side) {
    const statusClass = step.status || 'unchanged';
    const orderDisplay = step.order !== undefined ? step.order : '?';

    // Extract a title from the text content
    const title = step.textContent?.split('\n')[0]?.trim()?.substring(0, 50) || `Step ${orderDisplay}`;

    // Create unique ID for this step's iframe
    const iframeId = `snfc-iframe-${side}-${orderDisplay}-${Date.now()}`;

    // Store the HTML to inject after iframe loads
    if (!window.snfcPendingIframes) {
      window.snfcPendingIframes = {};
    }
    window.snfcPendingIframes[iframeId] = step.html;

    return `
      <div class="snfc-step snfc-step-${statusClass} snfc-extracted-step snfc-expanded" data-order="${orderDisplay}">
        <div class="snfc-step-header">
          <span class="snfc-step-order-badge">${orderDisplay}</span>
          <span class="snfc-step-name">${escapeHtml(title)}</span>
        </div>
        <div class="snfc-step-details">
          <iframe id="${iframeId}" class="snfc-extracted-iframe" frameborder="0" scrolling="no"></iframe>
        </div>
      </div>
    `;
  }

  // Initialize iframes with extracted HTML content
  function initializeExtractedIframes() {
    if (!window.snfcPendingIframes) return;

    Object.keys(window.snfcPendingIframes).forEach(iframeId => {
      const iframe = document.getElementById(iframeId);
      if (!iframe) return;

      const html = window.snfcPendingIframes[iframeId];
      delete window.snfcPendingIframes[iframeId];

      // Wait for iframe to be ready
      iframe.onload = () => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;

          // Copy all stylesheets from parent document
          const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).map(el => el.outerHTML).join('\n');

          doc.open();
          doc.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <base href="${window.location.origin}">
              ${styles}
              <style>
                body {
                  margin: 0;
                  padding: 8px;
                  background: transparent;
                  overflow: hidden;
                }
                /* Ensure content is visible */
                * {
                  visibility: visible !important;
                  opacity: 1 !important;
                }
              </style>
            </head>
            <body>${html}</body>
            </html>
          `);
          doc.close();

          // Auto-resize iframe to content
          setTimeout(() => {
            const body = doc.body;
            if (body) {
              const height = Math.max(body.scrollHeight, body.offsetHeight, 100);
              iframe.style.height = height + 'px';
            }
          }, 100);

          // Resize again after images/content loads
          setTimeout(() => {
            const body = doc.body;
            if (body) {
              const height = Math.max(body.scrollHeight, body.offsetHeight, 100);
              iframe.style.height = height + 'px';
            }
          }, 500);

        } catch (e) {
          console.error('[SN Flow Compare] Failed to initialize iframe:', e);
        }
      };

      // Trigger load by setting src to about:blank
      iframe.src = 'about:blank';
    });
  }

  // Render all extracted steps for comparison display
  function renderExtractedComparison(leftSteps, rightSteps) {
    const diff = compareExtractedSteps(leftSteps, rightSteps);

    // Update summary
    modal.querySelector('.snfc-summary').innerHTML = `
      <div class="snfc-summary-item snfc-added">+${diff.summary.added} Added</div>
      <div class="snfc-summary-item snfc-removed">-${diff.summary.removed} Removed</div>
      <div class="snfc-summary-item snfc-modified">~${diff.summary.modified} Modified</div>
      <div class="snfc-summary-item snfc-unchanged">${diff.summary.unchanged} Unchanged</div>
    `;

    // Render steps
    const leftHtml = diff.left.length > 0
      ? diff.left.map(s => renderExtractedStep(s, 'left')).join('')
      : '<div class="snfc-no-steps">No steps extracted from this version</div>';

    const rightHtml = diff.right.length > 0
      ? diff.right.map(s => renderExtractedStep(s, 'right')).join('')
      : '<div class="snfc-no-steps">No steps extracted from this version</div>';

    modal.querySelector('.snfc-column-left .snfc-steps-list').innerHTML = leftHtml;
    modal.querySelector('.snfc-column-right .snfc-steps-list').innerHTML = rightHtml;

    // Add click handlers for step expansion (synchronized between sides)
    modal.querySelectorAll('.snfc-step').forEach(step => {
      step.addEventListener('click', () => {
        const order = step.getAttribute('data-order');
        step.classList.toggle('snfc-expanded');

        // Find and toggle matching step on the other side (by order)
        const allSteps = modal.querySelectorAll(`.snfc-step[data-order="${order}"]`);
        allSteps.forEach(matchingStep => {
          if (matchingStep !== step) {
            matchingStep.classList.toggle('snfc-expanded', step.classList.contains('snfc-expanded'));
          }
        });
      });
    });

    // Add synchronized scrolling
    const leftList = modal.querySelector('.snfc-column-left .snfc-steps-list');
    const rightList = modal.querySelector('.snfc-column-right .snfc-steps-list');
    setupScrollSync(leftList, rightList);
  }

  // Setup synchronized scrolling between two elements
  function setupScrollSync(leftEl, rightEl) {
    if (!leftEl || !rightEl) return;

    let isScrolling = false;

    leftEl.addEventListener('scroll', () => {
      if (!isScrolling) {
        isScrolling = true;
        rightEl.scrollTop = leftEl.scrollTop;
        setTimeout(() => { isScrolling = false; }, 10);
      }
    });

    rightEl.addEventListener('scroll', () => {
      if (!isScrolling) {
        isScrolling = true;
        leftEl.scrollTop = rightEl.scrollTop;
        setTimeout(() => { isScrolling = false; }, 10);
      }
    });
  }

  // ==========================================
  // MODAL & MAIN LOGIC
  // ==========================================

  async function openCompareModal() {
    // Detect workflow type
    workflowType = detectWorkflowType();

    console.log('KD LOG: OPENING COMPARE MODAL')

    if (workflowType === WORKFLOW_TYPE.UNKNOWN) {
      showNotification('Please open a Flow Designer flow or Workflow Studio workflow first', 'warning');
      return;
    }

    // Extract workflow sys_id
    workflowSysId = extractWorkflowSysId();
    if (!workflowSysId) {
      showNotification('Could not detect workflow ID. Please ensure a workflow is open.', 'error');
      return;
    }

    // Close existing modal if open
    if (modal) {
      modal.remove();
    }

    const typeLabel = getWorkflowTypeLabel(workflowType);

    // Create modal
    modal = document.createElement('div');
    modal.className = 'snfc-modal';
    modal.innerHTML = `
      <div class="snfc-modal-content">
        <div class="snfc-modal-header">
          <h2>Version Comparison</h2>
          <button class="snfc-close-btn" title="Close">&times;</button>
        </div>
        <div class="snfc-error" style="display: none;"></div>
        <div class="snfc-compare-container" style="display: none;">
          <div class="snfc-column-headers">
            <div class="snfc-column-header snfc-column-header-left"></div>
            <div class="snfc-column-header snfc-column-header-right"></div>
          </div>
          <div class="snfc-comparison-rows"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Add event listeners
    modal.querySelector('.snfc-close-btn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Escape key to close
    const escHandler = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', escHandler);
    modal._escHandler = escHandler;

    // Load data
    try {
      // Check if we have comparison data from sidebar (clicked a history entry)
      const compareData = window.snfcCompareData;

      if (compareData && compareData.currentSteps) {
        console.log('[SN Flow Compare] Using stored comparison data from sidebar');
        const versionInfo = compareData.compareVersionInfo || {};

        // Extract steps one by one (opening each to get full content)
        const historicalResult = await extractStepsOneByOne();
        const historicalSteps = historicalResult.steps;
        const currentSteps = compareData.currentSteps;

        // Compare steps to find differences
        const currentStepNames = currentSteps.map(s => s.name || '');
        const historicalStepNames = historicalSteps.map(s => s.name || '');

        // Determine diff status for each step
        const getStepDiffClass = (stepName, isInOther, stepHtml, otherSteps) => {
          if (!isInOther) {
            return 'snfc-step-added'; // In current but not in historical = added
          }
          // Check if content is different
          const otherStep = otherSteps.find(s => (s.name || '') === stepName);
          if (otherStep && otherStep.html !== stepHtml) {
            return 'snfc-step-modified';
          }
          return 'snfc-step-unchanged';
        };

        const getHistoricalStepDiffClass = (stepName, isInCurrent, stepHtml, currentSteps) => {
          if (!isInCurrent) {
            return 'snfc-step-removed'; // In historical but not in current = removed
          }
          const currentStep = currentSteps.find(s => (s.name || '') === stepName);
          if (currentStep && currentStep.html !== stepHtml) {
            return 'snfc-step-modified';
          }
          return 'snfc-step-unchanged';
        };

        // Render a single step card
        const renderStepCard = (step, idx, diffClass) => `
          <div class="snfc-step ${diffClass}">
            <div class="snfc-step-header">
              <span class="snfc-step-number">${idx + 1}</span>
              <span class="snfc-step-name">${escapeHtml(step.name || 'Step')}</span>
              <span class="snfc-step-type">${escapeHtml(step.type || '')}</span>
              ${diffClass !== 'snfc-step-unchanged' ? `<span class="snfc-step-status">${diffClass.replace('snfc-step-', '')}</span>` : ''}
            </div>
            <div class="snfc-step-content">${step.html || ''}</div>
          </div>
        `;

        // Render empty placeholder for missing steps
        const renderPlaceholder = (message) => `
          <div class="snfc-step-placeholder">${escapeHtml(message)}</div>
        `;

        // Update headers
        modal.querySelector('.snfc-column-header-left').innerHTML = `
          <h3>Current (Working Version)</h3>
        `;
        modal.querySelector('.snfc-column-header-right').innerHTML = `
          <h3>Historical: ${escapeHtml(versionInfo.timestamp || 'Selected Version')}</h3>
          ${versionInfo.state ? `<span class="snfc-version-state">${escapeHtml(versionInfo.state)}</span>` : ''}
        `;

        // Build paired rows - match steps by index (since they should correspond)
        const maxSteps = Math.max(currentSteps.length, historicalSteps.length);
        const comparisonRows = modal.querySelector('.snfc-comparison-rows');

        if (maxSteps === 0) {
          comparisonRows.innerHTML = '<div class="snfc-info">No steps found to compare</div>';
        } else {
          let rowsHtml = '';

          for (let i = 0; i < maxSteps; i++) {
            const currentStep = currentSteps[i];
            const historicalStep = historicalSteps[i];

            // Determine diff classes
            let currentDiffClass = 'snfc-step-unchanged';
            let historicalDiffClass = 'snfc-step-unchanged';

            if (currentStep && !historicalStep) {
              currentDiffClass = 'snfc-step-added';
            } else if (!currentStep && historicalStep) {
              historicalDiffClass = 'snfc-step-removed';
            } else if (currentStep && historicalStep) {
              // Check if content differs
              const currentName = currentStep.name || '';
              const historicalName = historicalStep.name || '';

              if (currentName !== historicalName || currentStep.html !== historicalStep.html) {
                currentDiffClass = 'snfc-step-modified';
                historicalDiffClass = 'snfc-step-modified';
              }
            }

            rowsHtml += `<div class="snfc-comparison-row">`;

            // Left side: Current version
            if (currentStep) {
              rowsHtml += renderStepCard(currentStep, i, currentDiffClass);
            } else {
              rowsHtml += renderPlaceholder('Step not present in current version');
            }

            // Right side: Historical version
            if (historicalStep) {
              rowsHtml += renderStepCard(historicalStep, i, historicalDiffClass);
            } else {
              rowsHtml += renderPlaceholder('Step not present in historical version');
            }

            rowsHtml += `</div>`;
          }

          comparisonRows.innerHTML = rowsHtml;
        }

        // Clear stored data
        delete window.snfcCompareData;

      } else {
        // No comparison data - just show current page content
        console.log('[SN Flow Compare] No comparison data, showing current page only');

        modal.querySelector('.snfc-column-header-left').innerHTML = `<h3>Current Version</h3>`;
        modal.querySelector('.snfc-column-header-right').innerHTML = `<h3>Historical Version</h3>`;

        const comparisonRows = modal.querySelector('.snfc-comparison-rows');
        comparisonRows.innerHTML = `
          <div class="snfc-info">
            Select a version from the History sidebar to compare.<br>
            <small style="margin-top: 8px; display: block; opacity: 0.7;">
              Click the History button in Flow Designer, then click any version entry.
            </small>
          </div>
        `;
      }

      // Show the comparison container
      modal.querySelector('.snfc-compare-container').style.display = 'flex';

    } catch (error) {
      console.error('SN Flow Compare error:', error);
      hideLoadingOverlay();
      showError(`Failed to load data: ${error.message}`);
    }
  }

  function closeModal() {
    if (modal) {
      if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
      }
      modal.remove();
      modal = null;
    }
    hideLoadingOverlay();
  }

  function showError(message) {
    if (modal) {
      modal.querySelector('.snfc-error').style.display = 'block';
      modal.querySelector('.snfc-error').textContent = message;
    }
  }

  function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `snfc-toast snfc-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('snfc-toast-show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('snfc-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ==========================================
  // HISTORY SIDEBAR INTEGRATION
  // ==========================================

  // Get the state of a version entry from its badge
  function getEntryState(entry) {
    // Method 1: Try shadow DOM access
    const badge = entry.querySelector(STATE_BADGE_SELECTOR);

    if (badge) {
      if (badge.shadowRoot) {
        const span = badge.shadowRoot.querySelector('.now-highlighted-value');
        if (span) {
          if (span.classList.contains('-positive')) return 'Activated/Published';
          if (span.classList.contains('-info')) return 'Autosaved';
          if (span.classList.contains('-gray')) return 'Force saved';

          const label = span.querySelector('.now-highlighted-value-label');
          if (label) {
            const text = label.textContent.toLowerCase();
            if (text.includes('activated') || text.includes('published')) return 'Activated/Published';
            if (text.includes('autosaved') || text.includes('auto')) return 'Autosaved';
            if (text.includes('force')) return 'Force saved';
          }
        }
      }
    }

    // Method 2: Check entry's full text content for state keywords
    const entryText = entry.textContent.toLowerCase();
    if (entryText.includes('activated') || entryText.includes('published')) return 'Activated/Published';
    if (entryText.includes('autosaved')) return 'Autosaved';
    if (entryText.includes('force saved')) return 'Force saved';

    // Method 3: Look for any element with state-related text
    const allTextNodes = entry.querySelectorAll('*');
    for (const el of allTextNodes) {
      const text = el.textContent?.toLowerCase() || '';
      if (text.length < 50) {
        if (text.includes('activated') || text === 'published') return 'Activated/Published';
        if (text.includes('autosaved')) return 'Autosaved';
        if (text.includes('force')) return 'Force saved';
      }
    }

    // Method 4: Check for color-based class indicators
    const colorIndicators = entry.querySelectorAll('[class*="-positive"], [class*="-info"], [class*="-gray"], [class*="positive"], [class*="success"], [class*="green"]');
    for (const el of colorIndicators) {
      const cls = el.className.toLowerCase();
      if (cls.includes('positive') || cls.includes('success') || cls.includes('green')) return 'Activated/Published';
      if (cls.includes('info') || cls.includes('blue')) return 'Autosaved';
      if (cls.includes('gray') || cls.includes('grey')) return 'Force saved';
    }

    return 'unknown';
  }

  // Extract version information from a sidebar entry
  function extractVersionFromEntry(entry, index) {
    // Try multiple selectors for timestamp
    let timestampEl = entry.querySelector('.top .title');
    if (!timestampEl) timestampEl = entry.querySelector('.title');
    if (!timestampEl) timestampEl = entry.querySelector('[class*="title"]');
    if (!timestampEl) timestampEl = entry.querySelector('[class*="date"]');
    if (!timestampEl) timestampEl = entry.querySelector('[class*="time"]');

    // Try multiple selectors for modified by
    let modifiedByEl = entry.querySelector('.modified-by');
    if (!modifiedByEl) modifiedByEl = entry.querySelector('[class*="modified"]');
    if (!modifiedByEl) modifiedByEl = entry.querySelector('[class*="author"]');
    if (!modifiedByEl) modifiedByEl = entry.querySelector('[class*="user"]');

    // Extract timestamp - try from element or from text content
    let timestamp = timestampEl ? timestampEl.textContent.trim() : '';
    if (!timestamp) {
      const text = entry.textContent || '';
      const dateMatch = text.match(/\d{1,2}(st|nd|rd|th)\s+(January|February|March|April|May|June|July|August|September|October|November|December)[^,]*,?\s*\d{1,2}:\d{2}\s*(am|pm)?/i);
      if (dateMatch) {
        timestamp = dateMatch[0].trim();
      }
    }

    const modifiedBy = modifiedByEl ? modifiedByEl.textContent.trim() : '';
    const state = getEntryState(entry);

    return {
      index: index,
      element: entry,
      timestamp: timestamp || `Entry ${index + 1}`,
      modifiedBy: modifiedBy,
      state: state,
      isActivated: state === 'Activated/Published',
      isAutosaved: state === 'Autosaved',
      isForceSaved: state === 'Force saved'
    };
  }

  // Extract all versions from the History sidebar
  function extractVersionsFromSidebar() {
    const sidebarObj = findHistorySidebar();
    if (!sidebarObj || !sidebarObj.container) {
      return [];
    }

    const container = sidebarObj.container;

    // Try .entry first, then fallback to tabindex elements
    let entries = container.querySelectorAll('.entry');

    if (entries.length === 0) {
      const tabElements = container.querySelectorAll('[tabindex="0"]');
      entries = [...tabElements].filter(el =>
        el.textContent?.includes('Activated') ||
        el.textContent?.includes('Autosaved') ||
        el.textContent?.includes('Force saved') ||
        /\d{1,2}(st|nd|rd|th)\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i.test(el.textContent || '') ||
        /\d{1,2}:\d{2}\s*(am|pm)/i.test(el.textContent || '')
      );
    }

    const versions = [];
    entries.forEach((entry, idx) => {
      const version = extractVersionFromEntry(entry, idx);
      versions.push(version);
    });

    cachedVersionsFromSidebar = versions;
    return versions;
  }

  // Find the first Activated/Published entry in the sidebar
  function findActivatedEntry() {
    const versions = extractVersionsFromSidebar();
    const activated = versions.find(v => v.isActivated);

    if (activated) {
      console.log(`[SN Flow Compare] Found Activated entry at index ${activated.index}: ${activated.timestamp}`);
      lastActivatedVersion = activated;

      // Highlight the activated entry
      highlightActivatedEntry(activated.element);
    } else {
      console.log('[SN Flow Compare] No Activated/Published entry found in sidebar');
      lastActivatedVersion = null;
    }

    return activated;
  }

  // Highlight the activated entry in the sidebar
  function highlightActivatedEntry(entryElement) {
    // Remove any existing highlights
    document.querySelectorAll('.snfc-activated-highlight').forEach(el => {
      el.classList.remove('snfc-activated-highlight');
      el.style.border = '';
      el.style.boxShadow = '';
    });

    // Remove existing badge labels
    document.querySelectorAll('.snfc-activated-badge').forEach(el => el.remove());

    // Add highlight to the activated entry
    if (entryElement) {
      entryElement.classList.add('snfc-activated-highlight');
      entryElement.style.border = '2px solid #3fb950';
      entryElement.style.borderRadius = '8px';
      entryElement.style.boxShadow = '0 0 8px rgba(63, 185, 80, 0.3)';
      entryElement.style.position = 'relative';

      const badge = document.createElement('div');
      badge.className = 'snfc-activated-badge';
      badge.textContent = '✓ Last Activated';
      badge.style.cssText = 'position:absolute;top:-10px;right:8px;background:#3fb950;color:white;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;z-index:10;';
      entryElement.appendChild(badge);
    }
  }

  // Show the sidebar comparison indicator
  function showSidebarIndicator(message) {
    // Remove existing indicator
    document.querySelectorAll('.snfc-sidebar-indicator').forEach(el => el.remove());

    const sidebarObj = findHistorySidebar();
    if (!sidebarObj || !sidebarObj.container) return;

    const container = sidebarObj.container;
    container.querySelectorAll('.snfc-sidebar-indicator').forEach(el => el.remove());

    const indicator = document.createElement('div');
    indicator.className = 'snfc-sidebar-indicator';
    indicator.style.cssText = 'background:linear-gradient(135deg,#0078d4 0%,#005a9e 100%);color:white;padding:10px 12px;margin:8px;border-radius:6px;font-size:12px;box-shadow:0 2px 8px rgba(0,120,212,0.3);';

    const content = document.createElement('div');
    content.style.cssText = 'display:flex;align-items:center;gap:8px;';

    const icon = document.createElement('span');
    icon.textContent = '⚡';
    icon.style.fontSize = '16px';

    const text = document.createElement('span');
    text.textContent = message;
    text.style.cssText = 'flex:1;font-weight:500;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:rgba(255,255,255,0.2);border:none;color:white;width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      indicator.remove();
    });

    content.appendChild(icon);
    content.appendChild(text);
    content.appendChild(closeBtn);
    indicator.appendChild(content);

    const header = container.querySelector('.entry-panel-header, section, header');
    if (header && header.nextSibling) {
      header.parentNode.insertBefore(indicator, header.nextSibling);
    } else {
      container.insertBefore(indicator, container.firstChild);
    }

    return indicator;
  }

  // Add compare button to sidebar entries
  function addCompareButtonsToEntries() {
    const sidebarObj = findHistorySidebar();
    if (!sidebarObj || !sidebarObj.container) return;

    const container = sidebarObj.container;

    // Try multiple selectors for entries within the sidebar
    let entries = container.querySelectorAll('.entry');

    // Fallback: try [tabindex="0"] elements that look like version entries
    if (entries.length === 0) {
      const tabElements = container.querySelectorAll('[tabindex="0"]');
      entries = [...tabElements].filter(el =>
        el.textContent?.includes('Activated') ||
        el.textContent?.includes('Autosaved') ||
        el.textContent?.includes('Force saved') ||
        /\d{1,2}(st|nd|rd|th)\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i.test(el.textContent || '') ||
        /\d{1,2}:\d{2}\s*(am|pm)/i.test(el.textContent || '')
      );
    }

    if (entries.length === 0) return;

    entries.forEach((entry, idx) => {
      // Skip if button already exists
      if (entry.querySelector('.snfc-entry-compare-btn')) return;

      const version = extractVersionFromEntry(entry, idx);

      // Only add compare button to non-current entries (skip first entry which is current)
      if (idx === 0) return;

      const btn = document.createElement('button');
      btn.className = 'snfc-entry-compare-btn';
      btn.innerHTML = '⟷';
      btn.title = 'Compare with current version';
      btn.style.cssText = 'background:#0078d4;border:none;color:white;width:24px;height:24px;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;display:inline-flex;align-items:center;justify-content:center;margin-left:8px;flex-shrink:0;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        initiateCompareWithEntry(entry, version);
      });

      // Try multiple locations to insert the button
      let inserted = false;

      // Try 1: .top section
      const topSection = entry.querySelector('.top');
      if (topSection && !inserted) {
        topSection.style.display = 'flex';
        topSection.style.alignItems = 'center';
        topSection.appendChild(btn);
        inserted = true;
      }

      // Try 2: .title element's parent
      if (!inserted) {
        const titleEl = entry.querySelector('.title');
        if (titleEl && titleEl.parentElement) {
          titleEl.parentElement.style.display = 'flex';
          titleEl.parentElement.style.alignItems = 'center';
          titleEl.parentElement.appendChild(btn);
          inserted = true;
        }
      }

      // Try 3: Just append to the entry itself
      if (!inserted) {
        entry.style.position = 'relative';
        btn.style.position = 'absolute';
        btn.style.top = '8px';
        btn.style.right = '8px';
        entry.appendChild(btn);
      }
    });
  }

  // Generate a fingerprint of current page content for change detection
  function getPageContentFingerprint() {
    const container = document.querySelector('#app-floweditor, #flow-editor, .flow-editor');
    if (!container) return '';

    // Get a hash of step names/content to detect changes
    const steps = container.querySelectorAll('.instance-component-stage-container, .trigger-section, [class*="step"], [class*="action"]');
    const content = [...steps].map(s => s.textContent?.substring(0, 100) || '').join('|');
    return content.length + ':' + content.substring(0, 500);
  }

  // Initiate comparison by clicking an entry to load that version
  async function initiateCompareWithEntry(entryElement, versionInfo) {
    if (autoCompareInProgress) {
      showNotification('Comparison already in progress...', 'warning');
      return;
    }

    autoCompareInProgress = true;
    showNotification(`Extracting steps and loading version: ${versionInfo.timestamp}...`, 'info');

    try {
      // Extract steps one by one (opening each to get full content)
      const currentSteps = await extractStepsOneByOne();
      const currentFingerprint = getPageContentFingerprint();

      console.log(`[SN Flow Compare] Current page has ${currentSteps.steps.length} steps`);
      console.log(`[SN Flow Compare] Current fingerprint: ${currentFingerprint.substring(0, 100)}...`);

      // Store current version data
      window.snfcCompareData = {
        currentSteps: currentSteps.steps,
        currentFingerprint: currentFingerprint,
        compareVersionInfo: versionInfo,
        originalUrl: window.location.href
      };

      // Click the entry to load that version
      console.log('[SN Flow Compare] Clicking entry to load version...');
      entryElement.click();

      // Wait for the version to load (detect actual content change)
      await waitForVersionLoad(currentFingerprint, versionInfo);

    } catch (error) {
      console.error('[SN Flow Compare] Compare failed:', error);
      showNotification('Failed to load version: ' + error.message, 'error');
    } finally {
      autoCompareInProgress = false;
    }
  }

  // Wait for version to load after clicking an entry
  function waitForVersionLoad(originalFingerprint, versionInfo) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 40; // 20 seconds max

      const checkLoaded = () => {
        attempts++;

        const currentFingerprint = getPageContentFingerprint();
        const contentChanged = currentFingerprint !== originalFingerprint;

        console.log(`[SN Flow Compare] Check ${attempts}: contentChanged=${contentChanged}, versionInfo=${JSON.stringify(versionInfo)}`);

        // Wait for content to actually change
        if (contentChanged && attempts > 2) {
          console.log('[SN Flow Compare] Content changed, version loaded');
          console.log(`[SN Flow Compare] New fingerprint: ${currentFingerprint.substring(0, 100)}...`);

          // Give a bit more time for full render, then extract steps one by one
          setTimeout(async () => {
            // Extract steps one by one (opening each to get full content)
            const loadedSteps = await extractStepsOneByOne();
            console.log(`[SN Flow Compare] Historical version has ${loadedSteps.steps.length} steps`);
            // Now we have both versions - show comparison
            if (window.snfcCompareData) {
              showInlineComparison(
                window.snfcCompareData.currentSteps,  // Current/working version (before click)
                loadedSteps.steps,                      // Historical version (after click)
                versionInfo
              );
            }
            resolve(loadedSteps);
          }, 800);
          return;
        }

        // Also check if we've waited long enough even without change (maybe same content)
        if (attempts >= 10 && !contentChanged) {
          console.log('[SN Flow Compare] Content did not change after 5 seconds - versions might be identical');

          // Extract steps one by one
          extractStepsOneByOne().then((loadedSteps) => {
            if (window.snfcCompareData) {
              showInlineComparison(
                window.snfcCompareData.currentSteps,
                loadedSteps.steps,
                versionInfo
              );
            }
            resolve(loadedSteps);
          });
          return;
        }

        if (attempts >= maxAttempts) {
          reject(new Error('Timeout waiting for version to load'));
          return;
        }

        setTimeout(checkLoaded, 500);
      };

      setTimeout(checkLoaded, 500);
    });
  }

  // Show inline comparison panel (instead of modal)
  function showInlineComparison(currentSteps, comparedSteps, versionInfo) {
    // Remove existing comparison panel
    const existing = document.querySelector('.snfc-inline-compare-panel');
    if (existing) existing.remove();

    console.log('[SN Flow Compare] showInlineComparison called');
    console.log(`[SN Flow Compare] Current (working) version: ${currentSteps.length} steps`);
    console.log(`[SN Flow Compare] Historical version (${versionInfo.timestamp}): ${comparedSteps.length} steps`);

    // Generate diff - comparing current working version against historical version
    // currentSteps = the version you were editing (before clicking history entry)
    // comparedSteps = the historical version (loaded after clicking)
    const diff = compareExtractedSteps(currentSteps, comparedSteps);

    console.log('[SN Flow Compare] Diff summary:', diff.summary);

    // Create comparison panel
    const panel = document.createElement('div');
    panel.className = 'snfc-inline-compare-panel';
    panel.innerHTML = `
      <div class="snfc-inline-compare-header">
        <h3>Current vs ${escapeHtml(versionInfo.timestamp)}</h3>
        <div class="snfc-inline-compare-summary">
          <span class="snfc-added" title="Added in current">+${diff.summary.added}</span>
          <span class="snfc-removed" title="Removed from current">-${diff.summary.removed}</span>
          <span class="snfc-modified" title="Modified">~${diff.summary.modified}</span>
        </div>
        <button class="snfc-inline-compare-close" title="Close comparison">×</button>
      </div>
      <div class="snfc-inline-compare-body">
        <div class="snfc-inline-compare-info" style="font-size:11px;color:#888;margin-bottom:8px;">
          Comparing your current flow (${currentSteps.length} steps) with ${escapeHtml(versionInfo.state || 'historical')} version (${comparedSteps.length} steps)
        </div>
        <div class="snfc-inline-compare-message">
          ${diff.summary.added + diff.summary.removed + diff.summary.modified === 0
            ? 'No differences found between versions.'
            : `Found ${diff.summary.added + diff.summary.removed + diff.summary.modified} differences. Use Alt+Shift+C for detailed view.`}
        </div>
        <button class="snfc-inline-compare-detail-btn">Open Full Comparison</button>
      </div>
    `;

    document.body.appendChild(panel);

    // Add event handlers
    panel.querySelector('.snfc-inline-compare-close').addEventListener('click', () => {
      panel.remove();
    });

    panel.querySelector('.snfc-inline-compare-detail-btn').addEventListener('click', () => {
      panel.remove();
      openCompareModal();
    });

    // Auto-remove after 30 seconds
    setTimeout(() => {
      if (panel.parentNode) {
        panel.remove();
      }
    }, 30000);
  }

  // Shadow DOM host element selectors
  const SHADOW_HOST_SELECTORS = [
    'sn-bldr-badged-entry-panel',
    '[class*="badged-entry-panel"]',
    '[class*="entry-panel"]'
  ];

  // Find History sidebar - handles shadow DOM
  function findHistorySidebar() {
    // First, try to find the shadow DOM host element
    for (const selector of SHADOW_HOST_SELECTORS) {
      try {
        const host = document.querySelector(selector);
        if (host && host.shadowRoot) {
          const shadowContainer = host.shadowRoot.querySelector('.badged-entry-panel-container');
          if (shadowContainer) {
            return {
              container: shadowContainer,
              shadowRoot: host.shadowRoot,
              isShadow: true
            };
          }
        }
      } catch (e) {
        // Ignore errors
      }
    }

    // Also try querying inside known parent containers
    const parentSelectors = ['.side-pane', '#editor-body', '#flow-editor'];
    for (const parentSel of parentSelectors) {
      const parent = document.querySelector(parentSel);
      if (parent) {
        const shadowHosts = parent.querySelectorAll('*');
        for (const el of shadowHosts) {
          if (el.shadowRoot) {
            const shadowContainer = el.shadowRoot.querySelector('.badged-entry-panel-container');
            if (shadowContainer) {
              return {
                container: shadowContainer,
                shadowRoot: el.shadowRoot,
                isShadow: true
              };
            }
          }
        }
      }
    }

    // Fallback: regular DOM search (non-shadow)
    const regularSelectors = [
      '.badged-entry-panel-container',
      '[class*="entry-panel-container"]'
    ];

    for (const selector of regularSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        return { container: el, isShadow: false };
      }
    }

    return null;
  }

  // Start observing for History sidebar appearance
  function startHistorySidebarObserver() {
    if (historySidebarObserver) {
      historySidebarObserver.disconnect();
    }

    // Periodic check for sidebar
    let checkInterval = null;
    const checkForSidebar = () => {
      if (isHistorySidebarOpen) return;

      const sidebar = findHistorySidebar();
      if (sidebar) {
        isHistorySidebarOpen = true;
        if (checkInterval) clearInterval(checkInterval);
        onHistorySidebarOpened(sidebar);
      }
    };

    checkInterval = setInterval(checkForSidebar, 1000);

    // Stop checking after 5 minutes
    setTimeout(() => {
      if (checkInterval) clearInterval(checkInterval);
    }, 300000);

    // MutationObserver to detect when shadow host element appears
    historySidebarObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const host = node.matches?.('sn-bldr-badged-entry-panel') ? node :
                       node.querySelector?.('sn-bldr-badged-entry-panel');

          if (host && !isHistorySidebarOpen) {
            setTimeout(() => {
              const sidebarObj = findHistorySidebar();
              if (sidebarObj) {
                isHistorySidebarOpen = true;
                if (checkInterval) clearInterval(checkInterval);
                onHistorySidebarOpened(sidebarObj);
              }
            }, 300);
            return;
          }
        }

        for (const node of mutation.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const host = node.matches?.('sn-bldr-badged-entry-panel') ? node :
                       node.querySelector?.('sn-bldr-badged-entry-panel');

          if (host && isHistorySidebarOpen) {
            isHistorySidebarOpen = false;
            onHistorySidebarClosed();
            checkInterval = setInterval(checkForSidebar, 1000);
            return;
          }
        }
      }
    });

    historySidebarObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Check if sidebar is already open
    const existingSidebar = findHistorySidebar();
    if (existingSidebar) {
      isHistorySidebarOpen = true;
      if (checkInterval) clearInterval(checkInterval);
      onHistorySidebarOpened(existingSidebar);
    }
  }

  // Called when History sidebar opens
  function onHistorySidebarOpened(sidebarObj) {
    const container = sidebarObj?.container || sidebarObj;
    if (!container) return;

    // Function to process entries with retries
    const processEntries = (attempt = 1) => {
      let entries = container.querySelectorAll('.entry');

      // Fallback to tabindex elements
      if (entries.length === 0) {
        entries = container.querySelectorAll('[tabindex="0"]');
      }

      if (entries.length === 0 && attempt < 5) {
        setTimeout(() => processEntries(attempt + 1), attempt * 500);
        return;
      }

      const activated = findActivatedEntry();

      if (activated) {
        showSidebarIndicator(`Found last Activated version: ${activated.timestamp}`);
      } else {
        showSidebarIndicator('SN Flow Compare: Click ⟷ to compare versions');
      }

      addCompareButtonsToEntries();
      observeSidebarEntries(container);
    };

    setTimeout(() => processEntries(1), 800);
  }

  // Called when History sidebar closes
  function onHistorySidebarClosed() {
    cachedVersionsFromSidebar = [];
    lastActivatedVersion = null;
  }

  // Observe changes within the sidebar (entries being added/updated)
  function observeSidebarEntries(sidebar) {
    const entryObserver = new MutationObserver((mutations) => {
      let entriesChanged = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE &&
                (node.classList?.contains('entry') || node.querySelector?.('.entry'))) {
              entriesChanged = true;
              break;
            }
          }
        }
      }

      if (entriesChanged) {
        findActivatedEntry();
        addCompareButtonsToEntries();
      }
    });

    entryObserver.observe(sidebar, {
      childList: true,
      subtree: true
    });
  }

  // Watch for History button to appear
  function watchForHistoryButton() {

    // Check if button already exists
    const existingButton = document.querySelector(HISTORY_BUTTON_SELECTOR);
    if (existingButton) {
      onHistoryButtonFound(existingButton);
      return;
    }

    // Watch for button to appear
    if (historyButtonObserver) {
      historyButtonObserver.disconnect();
    }

    historyButtonObserver = new MutationObserver((mutations) => {
      const button = document.querySelector(HISTORY_BUTTON_SELECTOR);
      if (button) {
        onHistoryButtonFound(button);
        historyButtonObserver.disconnect();
      }
    });

    historyButtonObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Set a timeout to stop watching after 30 seconds
    setTimeout(() => {
      if (historyButtonObserver) {
        historyButtonObserver.disconnect();
      }
    }, 30000);
  }

  // Called when History button is found
  function onHistoryButtonFound(button) {

    // Start watching for the sidebar to open
    startHistorySidebarObserver();

    // Add click listener to History button
    button.addEventListener('click', () => {
      console.log('[SN Flow Compare] History button clicked');
      // The sidebar will be detected by the MutationObserver
    });
  }

  // Initialize History sidebar integration for Flow Designer pages
  function initHistorySidebarIntegration() {
    watchForHistoryButton();
    startHistorySidebarObserver();
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================

  // Initialize on page load
  function init() {
    initHistorySidebarIntegration();
  }

  // Run initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1000);
  }

  // Keyboard shortcut listener (backup for direct page handling)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      e.stopPropagation();
      openCompareModal();
    }
  }, true); // Use capture phase to intercept before ServiceNow handlers

})();
