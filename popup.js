// Popup script for SN Flow Compare

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Check if current tab is a ServiceNow page
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab && tab.url) {
      const url = tab.url.toLowerCase();
      const isServiceNow = url.includes('service-now.com') || url.includes('servicenow.com');

      const isFlowDesigner = url.includes('flow_designer') ||
                            url.includes('$flow-designer') ||
                            url.includes('/now/workflow/');

      const isWorkflowStudio = url.includes('workflow_ide.do') ||
                               url.includes('wf_workflow.do') ||
                               url.includes('workflow_version.do');

      if (isFlowDesigner) {
        statusDot.classList.remove('inactive');
        statusText.textContent = 'Flow Designer - Ready';
      } else if (isWorkflowStudio) {
        statusDot.classList.remove('inactive');
        statusText.textContent = 'Workflow Studio - Ready';
      } else if (isServiceNow) {
        statusDot.classList.add('inactive');
        statusText.textContent = 'Open a workflow to compare';
      } else {
        statusDot.classList.add('inactive');
        statusText.textContent = 'Not on ServiceNow';
      }
    }
  } catch (error) {
    console.error('Error checking tab:', error);
    statusText.textContent = 'Unable to detect page';
  }
});
