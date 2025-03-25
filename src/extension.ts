import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as util from 'util';

const execAsync = util.promisify(exec);

interface ResourceDetail {
    changeType: string;
    symbol: string;
    resourceType: string;
    resourceName: string;
    address: string;
    details: string;
}

interface ParseResult {
    summary: string;
    resourceDetails: Record<string, ResourceDetail>;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Terraform Plan Summarizer is now active!');

    let disposable = vscode.commands.registerCommand('terraform-plan-summarizer.summarize', async (uri: vscode.Uri) => {
        // Try to get content from clipboard or active editor
        let planOutput = '';
        let source = '';
        let filePath: string | undefined = undefined;

        if (uri && uri.fsPath) {
            filePath = uri.fsPath;
            try {
                const fileContent = (await vscode.workspace.fs.readFile(uri)).toString();
                if (isPlanOutput(fileContent)) {
                    planOutput = fileContent;
                    source = `${filePath}`;
                } else {
                    planOutput = await terraformShow(filePath);
                    source = `${filePath}`;
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to read file or execute terraform show: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
        } else {
            try {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const selection = editor.selection;
                    planOutput = editor.document.getText(selection);
                    source = 'Selection';

                    if (!planOutput || !isPlanOutput(planOutput)) {
                        planOutput = editor.document.getText();
                        source = 'Current File';
                        if (!isPlanOutput(planOutput)) {
                            planOutput = await vscode.env.clipboard.readText();
                            source = 'Clipboard';
                            if (!planOutput || !isPlanOutput(planOutput)) {
                                const filePath = editor.document.uri.fsPath;
                                try {
                                    planOutput = await terraformShow(filePath);
                                    source = `${filePath}`;
                                } catch (err) {
                                    // vscode.window.showErrorMessage(`Failed to execute terraform show: ${err instanceof Error ? err.message : String(err)}`);
                                    vscode.window.showErrorMessage('No valid Terraform plan found in selection, active editor, clipboard or current file as binary plan.');
                                    return;
                                }
                            }
                        }
                    }
                } else {
                    source = 'Clipboard';
                    planOutput = await vscode.env.clipboard.readText();
                    if (!planOutput || !isPlanOutput(planOutput)) {
                        vscode.window.showErrorMessage('No valid Terraform plan found in clipboard.');
                        return;
                    }
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to read content: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        }


        try {
            const panel = vscode.window.createWebviewPanel(
                'terraformPlanSummary',
                'Terraform Plan Summary',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    enableFindWidget: true
                }
            );
            
            const { summary, resourceDetails } = parsePlanOutput(planOutput);
            
            // Debug info
            console.log('Found resources:', Object.keys(resourceDetails).length);
            
            panel.webview.html = getWebviewContent(summary, resourceDetails, source);
            
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

    async function terraformShow(filePath: string): Promise<string> {
        try {
            const cwd = require('path').dirname(filePath);
            let { stdout, stderr } = await execAsync(`terraform show -no-color ${filePath}`, { cwd });
            if (stderr) {
                console.error(`stderr: ${stderr}`);
            }
            return stdout;
        } catch (error) {
            console.error(`exec error: ${error}`);
            throw error;
        }
    }

    let disposableInPlace = vscode.commands.registerCommand('terraform-plan-summarizer.summarizeInPlace', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active text editor.');
            return;
        }

        const selection = editor.selection;
        let planOutput = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

        if (!isPlanOutput(planOutput)) {
            vscode.window.showErrorMessage('No valid Terraform plan found.');
            return;
        }

        try {
            // Set syntax to Terraform
            vscode.languages.setTextDocumentLanguage(editor.document, 'terraform');

            const { summary, resourceDetails } = parsePlanOutput(planOutput);

            // Format the summary for in-place display
            let formattedSummary = '==================\n';
            let createCount = 0;
            let updateCount = 0;
            let destroyCount = 0;
            let replaceCreateCount = 0;
            let replaceDestroyCount = 0;

            Object.values(resourceDetails).forEach(detail => {
                switch (detail.changeType) {
                    case 'will be created':
                        createCount++;
                        break;
                    case 'will be updated in-place':
                        updateCount++;
                        break;
                    case 'will be destroyed':
                        destroyCount++;
                        break;
                    case 'must be replaced':
                        if (detail.symbol === '+/-') {
                            replaceCreateCount++;
                        } else if (detail.symbol === '-/+') {
                            replaceDestroyCount++;
                        }
                        break;
                }
            });

            if (createCount > 0) {
                formattedSummary += `    CREATE ${createCount}\n`;
            }
            if (updateCount > 0) {
                formattedSummary += `    UPDATE ${updateCount}\n`;
            }
            if (destroyCount > 0) {
                formattedSummary += `    DESTROY ${destroyCount}\n`;
            }
            if (replaceCreateCount > 0) {
                formattedSummary += `    REPLACE_CREATE ${replaceCreateCount}\n`;
            }
            if (replaceDestroyCount > 0) {
                formattedSummary += `    REPLACE_DESTROY ${replaceDestroyCount}\n`;
            }
            formattedSummary += '==================\n';

            // Extract resource details and format the plan output
            let planOutputFormatted = formattedSummary;
            Object.keys(resourceDetails).forEach(key => {
                const detail = resourceDetails[key];
                let changeType = '';
                switch (detail.changeType) {
                    case 'will be created':
                        changeType = 'CREATE';
                        break;
                    case 'will be updated in-place':
                        changeType = 'UPDATE';
                        break;
                    case 'will be destroyed':
                        changeType = 'DESTROY';
                        break;
                    case 'must be replaced':
                        if (detail.symbol === '+/-') {
                            changeType = 'REPLACE_CREATE';
                        } else if (detail.symbol === '-/+') {
                            changeType = 'REPLACE_DESTROY';
                        }
                        break;
                }
                planOutputFormatted += `\n# ${changeType} ${detail.address}\n`;
                planOutputFormatted += detail.details + '\n';
            });

            const replaceRange = selection.isEmpty ? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)) : selection;

            await editor.edit(editBuilder => {
                editBuilder.replace(replaceRange, planOutputFormatted);
            });

            // Go to top of the page
            await vscode.commands.executeCommand('revealLine', { lineNumber: 0, at: 'top' });

            vscode.window.showInformationMessage('Terraform plan summarized in-place.');

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to summarize plan in-place: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposableInPlace);
}

/**
 * Check if text appears to be terraform plan output
 */
function isPlanOutput(text: string): boolean {
    return text.includes('Terraform will perform the following actions') ||
        text.includes('No changes') ||
        text.includes('Plan:') ||
        text.includes('Changes to Outputs') ||
        (text.includes('resource') &&
            (text.includes('will be created') ||
                text.includes('will be updated') ||
                text.includes('must be replaced') ||
                text.includes('will be read') ||
                text.includes('will be destroyed')));
}

/**
 * Parse the terraform plan output
 */
function parsePlanOutput(planOutput: string): ParseResult {
    // Remove leading spaces
    planOutput = planOutput.replace(/^ {2}#/gm, '#');

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
        summary += `<div class="summary-header destroy" data-group="destroy"><h2 class="destroy">${destroyMatches.length} TO BE DESTROYED</h2></div>\n`;
        destroyMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy destroy-resource" data-address="${cleanedAddress}" style="white-space: nowrap">- ${resource}</div>\n`;
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
        summary += `<div class="summary-header destroy" data-group="replace-create"><h2 class="destroy">${replaceCreateBeforeDestroyMatches.length} CREATE BEFORE DESTROY REPLACEMENT</h2></div>\n`;
        replaceCreateBeforeDestroyMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy replace-create-resource" data-address="${cleanedAddress}" style="white-space: nowrap">+/- ${resource}</div>\n`;
        });
    }

    if (replaceDestroyBeforeCreateMatches.length > 0) {
        summary += `<div class="summary-header destroy" data-group="replace-destroy"><h2 class="destroy">${replaceDestroyBeforeCreateMatches.length} DESTROY BEFORE CREATE REPLACEMENT</h2></div>\n`;
        replaceDestroyBeforeCreateMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy replace-destroy-resource" data-address="${cleanedAddress}" style="white-space: nowrap">-/+ ${resource}</div>\n`;
        });
    }

    if (updateMatches.length > 0) {
        summary += `<div class="summary-header update" data-group="update"><h2 class="update">${updateMatches.length} TO BE UPDATED</h2></div>\n`;
        updateMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource update update-resource" data-address="${cleanedAddress}" style="white-space: nowrap">~ ${resource}</div>\n`;
        });
    }

    if (createMatches.length > 0) {
        summary += `<div class="summary-header create" data-group="create"><h2 class="create">${createMatches.length} TO BE CREATED</h2></div>\n`;
        createMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource create create-resource" data-address="${cleanedAddress}" style="white-space: nowrap">+ ${resource}</div>\n`;
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
    // Add two spaces before resource details
    planOutput = planOutput.replace(/^([+-~]) resource/gm, '  $1 resource');

    resourceAddresses.forEach(address => {
        // Escape the address for regex
        const escapedAddress = escapeRegExp(address);
        const escapedSymbol = escapeRegExp(symbol);

        // Create a pattern that looks for the specific block for this resource
        const pattern = new RegExp(
            `# ${escapedAddress} ${changeType}[\\s\\S]*?(${escapedSymbol})\\s+resource\\s+"([^"]+)"\\s+"([^"]+)"\\s+{([\\s\\S]*?)(?=(\n\\s{0,2}#|\nPlan\:|$))`,
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
                address: address,
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
function getWebviewContent(summary: string, resourceDetails: Record<string, ResourceDetail>, source: string): string {
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
            .summary-header {
                cursor: pointer;
            }
        </style>
    </head>
    <body>
        <h1>Terraform Plan Summary</h1>
        <p>From: ${source}</p>
        <div id="summary">
            ${summary}
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            const resourceDetails = ${JSON.stringify(resourceDetails)};

            // Function to toggle resource details visibility
            function toggleResourceDetails(group) {
                const resourceElements = document.querySelectorAll('.' + group + '-resource');
                
                // Determine if most elements are currently visible or hidden
                let visibleCount = 0;
                resourceElements.forEach(resource => {
                    let detailsElement = resource.nextElementSibling;
                    if (detailsElement && detailsElement.classList.contains('resource-details') && detailsElement.style.display === 'block') {
                        visibleCount++;
                    }
                });

                // Determine the target display state: if more than half are visible, collapse all; otherwise, expand all
                const shouldExpand = visibleCount <= resourceElements.length / 2;

                resourceElements.forEach(resource => {
                    const address = resource.getAttribute('data-address');
                    let detailsElement = resource.nextElementSibling;

                    if (!detailsElement || !detailsElement.classList.contains('resource-details')) {
                        if (resourceDetails[address]) {
                            detailsElement = document.createElement('pre');
                            detailsElement.className = 'resource-details';
                            detailsElement.textContent = resourceDetails[address].details;
                            detailsElement.style.display = shouldExpand ? 'block' : 'none';
                            resource.after(detailsElement);
                        } else {
                            console.log('No details found for:', address);
                            return;
                        }
                    } else {
                        detailsElement.style.display = shouldExpand ? 'block' : 'none';
                    }
                });
            }

            // Add click event listeners to summary headers
            document.querySelectorAll('.summary-header').forEach(header => {
                header.addEventListener('click', function(event) {
                    // Check if text is being selected
                    if (window.getSelection()?.toString()) {
                        return; // Do nothing if text is selected
                    }

                    const group = this.getAttribute('data-group');
                    toggleResourceDetails(group);
                });
            });

            // Add click event listeners to individual resources
            document.querySelectorAll('.resource').forEach(resource => {
                resource.addEventListener('click', function(event) {
                    // Check if text is being selected
                    if (window.getSelection()?.toString()) {
                        return; // Do nothing if text is selected
                    }

                    // Prevent the summary-header click from firing when clicking on a resource
                    event.stopPropagation();

                    const address = this.getAttribute('data-address');
                    let detailsElement = this.nextElementSibling;

                    if (detailsElement && detailsElement.classList.contains('resource-details')) {
                        detailsElement.style.display = detailsElement.style.display === 'block' ? 'none' : 'block';
                    } else {
                        if (resourceDetails[address]) {
                            detailsElement = document.createElement('pre');
                            detailsElement.className = 'resource-details';
                            detailsElement.textContent = resourceDetails[address].details;
                            detailsElement.style.display = 'block'; // Set initial display to block
                            this.after(detailsElement);
                        } else {
                            console.log('No details found for:', address);
                        }
                    }
                });
            });
        </script>
    </body>
    </html>`;
}

export function deactivate() {}
