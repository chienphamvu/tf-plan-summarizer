import * as vscode from 'vscode';

interface ResourceDetail {
    changeType: string;
    symbol: string;
    resourceType: string;
    resourceName: string;
    details: string;
}

interface ParseResult {
    summary: string;
    resourceDetails: Record<string, ResourceDetail>;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Terraform Plan Summarizer is now active!');

    let disposable = vscode.commands.registerCommand('terraform-plan-summarizer.summarize', async () => {
        // Try to get content from clipboard or active editor
        let planOutput = '';
        
        try {
            planOutput = await vscode.env.clipboard.readText();
            if (!planOutput || !isPlanOutput(planOutput)) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const document = editor.document;
                    planOutput = document.getText();
                }
                
                if (!isPlanOutput(planOutput)) {
                    vscode.window.showErrorMessage('No valid Terraform plan found in clipboard or active editor.');
                    return;
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to read content: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        
        try {
            const panel = vscode.window.createWebviewPanel(
                'terraformPlanSummary',
                'Terraform Plan Summary',
                vscode.ViewColumn.One,
                {
                    enableScripts: true
                }
            );
            
            const { summary, resourceDetails } = parsePlanOutput(planOutput);
            
            // Debug info
            console.log('Found resources:', Object.keys(resourceDetails).length);
            
            panel.webview.html = getWebviewContent(summary, resourceDetails);
            
            // Handle messages from the webview
            panel.webview.onDidReceiveMessage(
                message => {
                    switch (message.command) {
                        case 'alert':
                            vscode.window.showErrorMessage(message.text);
                            return;
                        case 'debug':
                            console.log(message.text);
                            return;
                    }
                },
                undefined,
                context.subscriptions
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to parse plan: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    context.subscriptions.push(disposable);
}

/**
 * Check if text appears to be terraform plan output
 */
function isPlanOutput(text: string): boolean {
    return text.includes('Terraform will perform the following actions') || 
           text.includes('No changes') ||
           text.includes('Plan:') ||
           (text.includes('resource') && 
            (text.includes('will be created') || 
             text.includes('will be updated') || 
             text.includes('will be destroyed')));
}

/**
 * Parse the terraform plan output
 */
function parsePlanOutput(planOutput: string): ParseResult {
    const createRegex = /# (.+?) will be created/g;
    const updateRegex = /# (.+?) will be updated in-place/g;
    const destroyRegex = /# (.+?) will be destroyed/g;
    const replaceRegex = /# (.+?) must be replaced/g;

    const createMatches = Array.from(planOutput.matchAll(createRegex)).map(match => match[1]);
    const updateMatches = Array.from(planOutput.matchAll(updateRegex)).map(match => match[1]);
    const destroyMatches = Array.from(planOutput.matchAll(destroyRegex)).map(match => match[1]);
    const replaceMatches = Array.from(planOutput.matchAll(replaceRegex)).map(match => match[1]);

    let summary = '';

    if (destroyMatches.length > 0) {
        summary += `<h2 class="destroy">${destroyMatches.length} TO BE DESTROYED</h2>\n`;
        destroyMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy" data-address="${cleanedAddress}">- ${resource}</div>\n`;
        });
    }
    const replaceCreateBeforeDestroyMatches = replaceMatches.filter(resource => {
        const regex = new RegExp(`# ${escapeRegExp(resource)} must be replaced\\n\\s*\\+/`);
        return regex.test(planOutput);
    });

    const replaceDestroyBeforeCreateMatches = replaceMatches.filter(resource => {
        const regex = new RegExp(`# ${escapeRegExp(resource)} must be replaced\\n\\s*-/`);
        return regex.test(planOutput);
    });

    if (replaceCreateBeforeDestroyMatches.length > 0) {
        summary += `<h2 class="destroy">${replaceCreateBeforeDestroyMatches.length} CREATE BEFORE DESTROY REPLACEMENT</h2>\n`;
        replaceCreateBeforeDestroyMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy" data-address="${cleanedAddress}">+/- ${resource}</div>\n`;
        });
    }

    if (replaceDestroyBeforeCreateMatches.length > 0) {
        summary += `<h2 class="destroy">${replaceDestroyBeforeCreateMatches.length} DESTROY BEFORE CREATE REPLACEMENT</h2>\n`;
        replaceDestroyBeforeCreateMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy" data-address="${cleanedAddress}">-/+ ${resource}</div>\n`;
        });
    }

    if (updateMatches.length > 0) {
        summary += `<h2 class="update">${updateMatches.length} TO BE UPDATED</h2>\n`;
        updateMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource update" data-address="${cleanedAddress}">~ ${resource}</div>\n`;
        });
    }

    if (createMatches.length > 0) {
        summary += `<h2 class="create">${createMatches.length} TO BE CREATED</h2>\n`;
        createMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource create" data-address="${cleanedAddress}">+ ${resource}</div>\n`;
        });
    }
    
    if (summary === '') {
        summary = '<h2>No changes detected in plan</h2>';
    }
    
    // Extract resource details
    const resourceDetails: Record<string, ResourceDetail> = {};
    
    // Process resources to be created
    extractResourceDetails(planOutput, createMatches, 'will be created', '+', resourceDetails);
    
    // // Process resources to be updated
    extractResourceDetails(planOutput, updateMatches, 'will be updated in-place', '~', resourceDetails);
    
    // // Process resources to be destroyed
    extractResourceDetails(planOutput, destroyMatches, 'will be destroyed', '-', resourceDetails);

    // Process resources must be replaced
    replaceCreateBeforeDestroyMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'must be replaced', '+/-', resourceDetails);
    });
    replaceDestroyBeforeCreateMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'must be replaced', '-/+', resourceDetails);
    });

    return { summary, resourceDetails };
}

/**
 * Extract resource details from plan output
 */
function extractResourceDetails(
    planOutput: string,
    resourceAddresses: string[],
    changeType: string,
    symbol: string,
    resourceDetails: Record<string, ResourceDetail>
): void {
    resourceAddresses.forEach(address => {
        // Escape the address for regex
        const escapedAddress = escapeRegExp(address);
        const escapedSymbol = escapeRegExp(symbol);

        // Create a pattern that looks for the specific block for this resource
        const pattern = new RegExp(
            `# ${escapedAddress} ${changeType}[\\s\\S]*?(${escapedSymbol})\\s+resource\\s+"([^"]+)"\\s+"([^"]+)"\\s+{([\\s\\S]*?)(?=(\n\\s {0,2}#|\nPlan\:|$))`,
            'i'
        );

        const match = planOutput.match(pattern);

        if (match) {
            const details = match[4];
            const resourceType = match[2];
            const resourceName = match[3];

            // Remove quotes from the key
            const cleanedAddress = address.replace(/"/g, '');

            resourceDetails[cleanedAddress] = {
                changeType,
                symbol,
                resourceType,
                resourceName,
                details: `  ${symbol} resource "${resourceType}" "${resourceName}" {${details}`
            };
        } else {
            console.log(`Failed to find details for ${address}`);
        }
    });
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate the HTML for the webview
 */
function getWebviewContent(summary: string, resourceDetails: Record<string, ResourceDetail>): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Terraform Plan Summary</title>
        <style>
            body {
                font-family: var(--vscode-editor-font-family);
                padding: 20px;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
            }
            h1 {
                font-size: 1.5em;
                margin-bottom: 20px;
            }
            h2 {
                font-size: 1.2em;
                margin-top: 20px;
                margin-bottom: 10px;
            }
            .create {
                color: #4CAF50;
            }
            .update {
                color: #FF9800;
            }
            .destroy {
                color: #F44336;
            }
            .resource {
                cursor: pointer;
                padding: 5px;
                margin: 2px 0;
                border-radius: 4px;
            }
            .resource:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            .resource-details {
                display: none;
                background-color: var(--vscode-editor-background);
                padding: 10px;
                margin: 5px 0 10px 20px;
                border-left: 3px solid var(--vscode-editorLineNumber-foreground);
                font-family: monospace;
                white-space: pre-wrap;
                overflow-x: auto;
            }
            .debug-info {
                margin-top: 20px;
                font-size: 0.8em;
                color: #888;
            }
        </style>
    </head>
    <body>
        <h1>Terraform Plan Summary</h1>
        <div id="summary">
            ${summary}
        </div>
        
        <script>
            // For debugging purposes
            const vscode = acquireVsCodeApi();
            
            // Resource details from the extension
            const resourceDetails = ${JSON.stringify(resourceDetails)};
            
            // Log available resources
            const resourceCount = Object.keys(resourceDetails).length;
            vscode.postMessage({
                command: 'debug',
                text: 'Resource details available: ' + resourceCount
            });
            
            // Add click event listeners to all resources
            document.querySelectorAll('.resource').forEach(element => {
                element.addEventListener('click', function() {
                    const address = this.getAttribute('data-address');
                    console.log('Clicked on:', address);
                    
                    // Check if details are already showing
                    let detailsElement = this.nextElementSibling;
                    if (detailsElement && detailsElement.classList.contains('resource-details')) {
                        // Toggle visibility
                        detailsElement.style.display = detailsElement.style.display === 'block' ? 'none' : 'block';
                    } else {
                        // Create new details element
                        if (resourceDetails[address]) {
                            console.log('Found details for:', address);
                            const details = document.createElement('pre');  // Changed from div to pre
                            details.className = 'resource-details';
                            details.textContent = resourceDetails[address].details;
                            details.style.display = 'block';
                            this.after(details);
                        } else {
                            console.log('No details found for:', address, 'Available:', Object.keys(resourceDetails));
                        }
                    }
                });
            });
            
        </script>
    </body>
    </html>`;
}

export function deactivate() {}
