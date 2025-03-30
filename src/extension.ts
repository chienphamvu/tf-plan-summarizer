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
        try {
            const { planOutput, source, filePath } = await detectPlanSource(uri);

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

    let disposableInPlace = vscode.commands.registerCommand('terraform-plan-summarizer.summarizeInEditor', async (uri: vscode.Uri) => {
        try {
            const { planOutput, source, filePath } = await detectPlanSource(uri);

            const { summary, resourceDetails } = parsePlanOutput(planOutput);

            // Group resources by change type
            const createResources: ResourceDetail[] = [];
            const updateResources: ResourceDetail[] = [];
            const destroyResources: ResourceDetail[] = [];
            const replaceCreateResources: ResourceDetail[] = [];
            const replaceDestroyResources: ResourceDetail[] = [];
            const outsideChangeResources: ResourceDetail[] = [];
            const outputChangeResources: ResourceDetail[] = [];

            Object.values(resourceDetails).forEach(detail => {
                switch (detail.changeType) {
                    case 'output change':
                        outputChangeResources.push(detail);
                        break;
                    case 'will be created':
                        createResources.push(detail);
                        break;
                    case 'will be updated in-place':
                        updateResources.push(detail);
                        break;
                    case 'will be destroyed':
                        destroyResources.push(detail);
                        break;
                    case 'must be replaced':
                    case 'is tainted, so must be replaced':
                        if (detail.symbol === '+/-') {
                            replaceCreateResources.push(detail);
                        } else if (detail.symbol === '-/+') {
                            replaceDestroyResources.push(detail);
                        }
                        break;
                    case 'has been changed':
                    case 'has changed':
                    case 'has been deleted':
                    case 'has been destroyed':
                        outsideChangeResources.push(detail);
                        break;
                }
            });

            // Format the summary for in-place display
            let planOutputFormatted = '======================\n';
            planOutputFormatted += 'Terraform Plan Summary\n\n';
            planOutputFormatted += `From: ${source}\n`;
            planOutputFormatted += '======================\n\n';

            if (destroyResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${destroyResources.length} DESTROY\n`;
                planOutputFormatted += "==================";
                destroyResources.forEach(detail => {
                    planOutputFormatted += `\n${detail.symbol} ${detail.address}\n`;
                    planOutputFormatted += detail.details + '\n';
                });
            }
            if (replaceCreateResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${replaceCreateResources.length} REPLACE: CREATE BEFORE DESTROY\n`;
                planOutputFormatted += "==================";
                replaceCreateResources.forEach(detail => {
                    const tainted = detail.changeType === 'is tainted, so must be replaced' ? '(tainted) ' : '';
                    planOutputFormatted += `\n${detail.symbol} ${tainted}${detail.address}\n`;
                    planOutputFormatted += detail.details + '\n';
                });
            }
            if (replaceDestroyResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${replaceDestroyResources.length} REPLACE: DESTROY BEFORE CREATE\n`;
                planOutputFormatted += "==================";
                replaceDestroyResources.forEach(detail => {
                    const tainted = detail.changeType === 'is tainted, so must be replaced' ? '(tainted) ' : '';
                    planOutputFormatted += `\n${detail.symbol} ${tainted}${detail.address}\n`;
                    planOutputFormatted += detail.details + '\n';
                });
            }
            if (updateResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${updateResources.length} UPDATE\n`;
                planOutputFormatted += "==================";
                updateResources.forEach(detail => {
                    planOutputFormatted += `\n${detail.symbol} ${detail.address}\n`;
                    planOutputFormatted += detail.details + '\n';
                });
            }
            if (createResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${createResources.length} CREATE\n`;
                planOutputFormatted += "==================";
                createResources.forEach(detail => {
                    planOutputFormatted += `\n${detail.symbol} ${detail.address}\n`;
                    planOutputFormatted += detail.details + '\n';
                });
            }

            if (outputChangeResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${outputChangeResources.length} OUTPUT CHANGES\n`;
                planOutputFormatted += "==================";

                const orderedSymbols = ['-', '~', '+'];

                orderedSymbols.forEach(symbol => {
                    outputChangeResources.forEach(detail => {
                        if (detail.symbol === symbol) {
                            let outputDetails = detail.details;
                            let outputName = detail.address.replace('output.', '');
                            if (outputDetails.startsWith('{')) {
                                outputDetails = outputDetails.substring(1);
                                planOutputFormatted += `\n${detail.symbol} ${outputName} = {\n`;
                                planOutputFormatted += outputDetails;
                            } else if (outputDetails.startsWith('[')) {
                                outputDetails = outputDetails.substring(1);
                                planOutputFormatted += `\n${detail.symbol} ${outputName} = [\n`;
                                planOutputFormatted += outputDetails;
                            }
                            else {
                                planOutputFormatted += `\n${detail.symbol} ${outputName} = ${outputDetails}`;
                            }
                        }
                    });
                });
            }

            if (outsideChangeResources.length > 0) {
                planOutputFormatted += "==================\n";
                planOutputFormatted += `${outsideChangeResources.length} CHANGES OUTSIDE TERRAFORM\n`;
                planOutputFormatted += "==================";
                outsideChangeResources.forEach(detail => {
                    planOutputFormatted += `\n${detail.symbol} ${detail.address}\n`;
                    planOutputFormatted += detail.details + '\n';
                });
            }

            // Create a new text document
            const doc = await vscode.workspace.openTextDocument({ content: planOutputFormatted, language: 'terraform' });
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);

            // Fold all sections
            const document = editor.document;
            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                if (line.text.match(/^(\+|\-|\~|\-\/\+|\+\/\-)\s.*/)) {
                    editor.selection = new vscode.Selection(line.range.start, line.range.start);
                    await vscode.commands.executeCommand('editor.fold', {
                        levels: 1,
                        direction: 'down'
                    });
                }
            }

            // Move cursor to top
            await vscode.commands.executeCommand('revealLine', { lineNumber: 0, at: 'top' });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to summarize plan in-place: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposableInPlace);
}

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

async function detectPlanSource(uri?: vscode.Uri): Promise<{ planOutput: string; source: string; filePath: string | undefined }> {
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
            throw new Error(`Failed to read file or execute terraform show: ${err instanceof Error ? err.message : String(err)}`);
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
                                throw new Error('No valid Terraform plan found in selection, active editor, clipboard or current file as binary plan.');
                            }
                        }
                    }
                }
            } else {
                source = 'Clipboard';
                planOutput = await vscode.env.clipboard.readText();
                if (!planOutput || !isPlanOutput(planOutput)) {
                    throw new Error('No valid Terraform plan found in clipboard.');
                }
            }
        } catch (error) {
            throw error;
        }
    }

    return { planOutput, source, filePath };
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

    const outputResourceDetails: Record<string, ResourceDetail> = {};

    const outputChangesRegex = /Changes to Outputs:\n([\s\S]*?)(?=\nTerraform will perform the following actions:|\nNote: Objects have changed outside of Terraform|\nPlan:|$)/g;
    const outputChangesMatches = outputChangesRegex.exec(planOutput);

    const createRegex = /# (.+?) will be created/g;
    const updateRegex = /# (.+?) will be updated in-place/g;
    const destroyRegex = /# (.+?) will be destroyed/g;
    const replaceRegex = /# ([^ ]+?) must be replaced/g;
    const replaceTaintedRegex = /# (.+?) is tainted, so must be replaced/g;

    const createMatches = Array.from(planOutput.matchAll(createRegex)).map(match => match[1]);
    const updateMatches = Array.from(planOutput.matchAll(updateRegex)).map(match => match[1]);
    const destroyMatches = Array.from(planOutput.matchAll(destroyRegex)).map(match => match[1]);
    const replaceMatches = Array.from(planOutput.matchAll(replaceRegex)).map(match => match[1]);
    const replaceTaintedMatches = Array.from(planOutput.matchAll(replaceTaintedRegex)).map(match => match[1]);

    const outsideChangeWasModifiedRegex = /# (.+?) has been changed/g;
    const outsideChangeModifiedRegex = /# (.+?) has changed/g;
    const outsideChangeDeletedRegex = /# (.+?) has been deleted/g;
    const outsideChangeDestroyedRegex = /# (.+?) has been destroyed/g;

    const outsideChangeWasModifiedMatches = Array.from(planOutput.matchAll(outsideChangeWasModifiedRegex)).map(match => match[1]);
    const outsideChangeModifiedMatches = Array.from(planOutput.matchAll(outsideChangeModifiedRegex)).map(match => match[1]);
    const outsideChangeDeletedMatches = Array.from(planOutput.matchAll(outsideChangeDeletedRegex)).map(match => match[1]);
    const outsideChangeDestroyedMatches = Array.from(planOutput.matchAll(outsideChangeDestroyedRegex)).map(match => match[1]);

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
    const replaceTaintedCreateBeforeDestroyMatches = replaceTaintedMatches.filter(resource => {
        const regex = new RegExp(`# ${escapeRegExp(resource)} is tainted, so must be replaced\\n\\s*\\+/`);
        return regex.test(planOutput);
    });

    const replaceDestroyBeforeCreateMatches = replaceMatches.filter(resource => {
        const regex = new RegExp(`# ${escapeRegExp(resource)} must be replaced\\n\\s*-/`);
        return regex.test(planOutput);
    });
    const replaceTaintedDestroyBeforeCreateMatches = replaceTaintedMatches.filter(resource => {
        const regex = new RegExp(`# ${escapeRegExp(resource)} is tainted, so must be replaced\\n\\s*-/`);
        return regex.test(planOutput);
    });

    if (replaceCreateBeforeDestroyMatches.length > 0 || replaceTaintedCreateBeforeDestroyMatches.length > 0) {
        summary += `<div class="summary-header destroy" data-group="replace-create"><h2 class="destroy">${replaceCreateBeforeDestroyMatches.length + replaceTaintedCreateBeforeDestroyMatches.length} CREATE BEFORE DESTROY REPLACEMENT</h2></div>\n`;
        replaceCreateBeforeDestroyMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy replace-create-resource" data-address="${cleanedAddress}" style="white-space: nowrap">+/- ${resource}</div>\n`;
        });
        replaceTaintedCreateBeforeDestroyMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy replace-create-resource" data-address="${cleanedAddress}" style="white-space: nowrap">+/- (tainted) ${resource}</div>\n`;
        });
    }

    if (replaceDestroyBeforeCreateMatches.length > 0 || replaceTaintedDestroyBeforeCreateMatches.length > 0) {
        summary += `<div class="summary-header destroy" data-group="replace-destroy"><h2 class="destroy">${replaceDestroyBeforeCreateMatches.length + replaceTaintedDestroyBeforeCreateMatches.length} DESTROY BEFORE CREATE REPLACEMENT</h2></div>\n`;
        replaceDestroyBeforeCreateMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy replace-destroy-resource" data-address="${cleanedAddress}" style="white-space: nowrap">-/+ ${resource}</div>\n`;
        });
        replaceTaintedDestroyBeforeCreateMatches.forEach(resource => {
            // Remove quotes from data-address
            const cleanedAddress = resource.replace(/"/g, '');
            summary += `<div class="resource destroy replace-destroy-resource" data-address="${cleanedAddress}" style="white-space: nowrap">-/+ (tainted) ${resource}</div>\n`;
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

    if (outsideChangeWasModifiedMatches.length > 0 || outsideChangeModifiedMatches.length > 0 || outsideChangeDeletedMatches.length > 0 || outsideChangeDestroyedMatches.length > 0) {
        summary += `<div class="summary-header outside-change" data-group="outside-change"><h2>${outsideChangeWasModifiedMatches.length + outsideChangeModifiedMatches.length + outsideChangeDeletedMatches.length + outsideChangeDestroyedMatches.length} CHANGES OUTSIDE TERRAFORM</h2></div>\n`;

        const orderedSymbols = ['-', '~'];

        orderedSymbols.forEach(symbol => {
            if (symbol === '-') {
                outsideChangeDeletedMatches.forEach(resource => {
                    const cleanedAddress = resource.replace(/"/g, '');
                    summary += `<div class="resource" data-address="${cleanedAddress}" style="white-space: nowrap"><span class="destroy">-</span> ${resource}</div>\n`;
                });

                outsideChangeDestroyedMatches.forEach(resource => {
                    const cleanedAddress = resource.replace(/"/g, '');
                    summary += `<div class="resource" data-address="${cleanedAddress}" style="white-space: nowrap"><span class="destroy">-</span> ${resource}</div>\n`;
                });
            } else if (symbol === '~') {
                outsideChangeWasModifiedMatches.forEach(resource => {
                    const cleanedAddress = resource.replace(/"/g, '');
                    summary += `<div class="resource" data-address="${cleanedAddress}" style="white-space: nowrap"><span class="update">~</span> ${resource}</div>\n`;
                });

                outsideChangeModifiedMatches.forEach(resource => {
                    const cleanedAddress = resource.replace(/"/g, '');
                    summary += `<div class="resource" data-address="${cleanedAddress}" style="white-space: nowrap"><span class="update">~</span> ${resource}</div>\n`;
                });
            }
        });
    }

    // Handle Output changes
    if (outputChangesMatches && outputChangesMatches[1]) {
        const changes = outputChangesMatches[1].trim().split('\n');

        let currentOutput = '';

        changes.forEach(change => {
            const outputChangeRegex = /^([\+\-\~])\s+([^=]+?)\s*=\s*(.*)$/;
            const outputChangeMatch = change.match(outputChangeRegex);

            if (outputChangeMatch) {
                const symbol = outputChangeMatch[1];
                const outputName = outputChangeMatch[2].trim();
                let details = outputChangeMatch[3].trim();
                const cleanedOutputName = outputName.replace(/"/g, '');
                currentOutput = cleanedOutputName;

                if (details.startsWith('[') || details.startsWith('{')) {
                    outputResourceDetails[`output.${cleanedOutputName}`] = {
                        changeType: 'output change',
                        symbol: symbol,
                        resourceType: 'output',
                        resourceName: cleanedOutputName,
                        address: `output.${cleanedOutputName}`,
                        details: details.startsWith('[') ? '[' : '{'
                    };
                } else {
                    outputResourceDetails[`output.${cleanedOutputName}`] = {
                        changeType: 'output change',
                        symbol: symbol,
                        resourceType: 'output',
                        resourceName: cleanedOutputName,
                        address: `output.${cleanedOutputName}`,
                        details: details
                    };
                }
            } else if (currentOutput) {
                if (change.startsWith(' ')) {
                    if (outputResourceDetails[`output.${currentOutput}`].details === "[" || outputResourceDetails[`output.${currentOutput}`].details === "{") {
                        // prevent the first redundant new line
                        outputResourceDetails[`output.${currentOutput}`].details += change;
                    } else {
                        outputResourceDetails[`output.${currentOutput}`].details += '\n' + change;
                    }
                } else {
                    currentOutput = '';
                }
            }
        });

        summary += `<div class="summary-header output-change" data-group="output-change"><h2>CHANGES TO OUTPUTS</h2></div>\n`;
        const orderedSymbols = ['-', '~', '+'];

        orderedSymbols.forEach(symbol => {
            Object.keys(outputResourceDetails).forEach(key => {
                if (outputResourceDetails[key].changeType === 'output change' && outputResourceDetails[key].symbol === symbol) {
                    const resource = outputResourceDetails[key];
                    const type = resource.details.startsWith('[') || resource.details.startsWith('{') ? (resource.details.startsWith('[') ? 'array' : 'map') : '';
                    if (type) {
                        summary += `<div class="resource output-change-resource" data-address="${resource.address}" data-output-name="${resource.resourceName}" data-output-type="${type}" style="white-space: nowrap"><span class="${getChangeClass(symbol)}">${symbol}</span> ${resource.resourceName} = ${type === "array" ? "[" : "{"}...${type === "array" ? "]" : "}"}</div>\n`;
                    } else {
                        summary += `<div class="resource no-hover" style="white-space: nowrap"><span class="${getChangeClass(symbol)}">${symbol}</span> ${resource.resourceName} = ${resource.details}</div>\n`;
                    }
                }
            });
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

    // Process outside changes
    outsideChangeWasModifiedMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'has been changed', '~', resourceDetails);
    });
    outsideChangeModifiedMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'has changed', '~', resourceDetails);
    });
    outsideChangeDeletedMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'has been deleted', '-', resourceDetails);
    });
    outsideChangeDestroyedMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'has been destroyed', '-', resourceDetails);
    });

    replaceTaintedCreateBeforeDestroyMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'is tainted, so must be replaced', '+/-', resourceDetails);
    });
    replaceTaintedDestroyBeforeCreateMatches.forEach(resource => {
        extractResourceDetails(planOutput, [resource], 'is tainted, so must be replaced', '-/+', resourceDetails);
    });

    Object.assign(resourceDetails, outputResourceDetails);

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

function getChangeClass(symbol: string): string {
    switch (symbol) {
        case '+':
            return 'create';
        case '~':
            return 'update';
        case '-':
            return 'destroy';
        default:
            return '';
    }
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
            .resource.no-hover:hover {
                background-color: transparent;
                cursor: default;
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
            .output-resource-details {
                padding: 0 10px 10px 10px;
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
                    const isOutput = resource.dataset.outputType === 'array' || resource.dataset.outputType === 'map';

                    if (!detailsElement || !detailsElement.classList.contains('resource-details')) {
                        if (resourceDetails[address]) {
                            detailsElement = document.createElement('pre');
                            detailsElement.className = 'resource-details' + (isOutput ? ' output-resource-details' : '');
                            let detailsText = resourceDetails[address].details;
                            if (isOutput && (detailsText.startsWith('[') || detailsText.startsWith('{'))) {
                                detailsText = detailsText.substring(1);
                            }
                            detailsElement.textContent = detailsText;
                            detailsElement.style.display = shouldExpand ? 'block' : 'none';
                            resource.after(detailsElement);

                            // Update the resource text based on the display state
                            if (isOutput) {
                                if (shouldExpand) {
                                    resource.innerHTML = resource.innerHTML.replace(' = {...}', ' = {');
                                    resource.innerHTML = resource.innerHTML.replace(' = [...]', ' = [');
                                } else {
                                    resource.innerHTML = resource.innerHTML.replace(' = {', ' = {...}');
                                    resource.innerHTML = resource.innerHTML.replace(' = [', ' = [...]');
                                }
                            }
                        } else {
                            console.log('No details found for:', address);
                            return;
                        }
                    } else {
                        detailsElement.style.display = shouldExpand ? 'block' : 'none';

                        // Update the resource text based on the display state
                        if (isOutput) {
                            if (shouldExpand) {
                                resource.innerHTML = resource.innerHTML.replace(' = {...}', ' = {');
                                resource.innerHTML = resource.innerHTML.replace(' = [...]', ' = [');
                            } else {
                                resource.innerHTML = resource.innerHTML.replace(' = {', ' = {...}');
                                resource.innerHTML = resource.innerHTML.replace(' = [', ' = [...]');
                            }
                        }
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
                    const isOutput = this.dataset.outputType === 'array' || this.dataset.outputType === 'map';

                    if (detailsElement && detailsElement.classList.contains('resource-details')) {
                        detailsElement.style.display = detailsElement.style.display === 'block' ? 'none' : 'block';
                        if (detailsElement.style.display === 'block') {
                            // If details are shown, remove the "..."
                            if (this.dataset.outputType === 'array' || this.dataset.outputType === 'map') {
                                this.innerHTML = this.innerHTML.replace(' = {...}', ' = {');
                                this.innerHTML = this.innerHTML.replace(' = [...]', ' = [');
                            }
                        } else {
                            // If details are hidden, add the "..." back
                            this.innerHTML = this.innerHTML.replace(' = [', ' = [...]');
                            this.innerHTML = this.innerHTML.replace(' = {', ' = {...}');
                        }
                    } else {
                        if (resourceDetails[address]) {
                            detailsElement = document.createElement('pre');
                            detailsElement.className = 'resource-details' + (isOutput ? ' output-resource-details' : '');
                            let detailsText = resourceDetails[address].details;
                            if (isOutput && (detailsText.startsWith('[') || detailsText.startsWith('{'))) {
                                detailsText = detailsText.substring(1);
                            }
                            detailsElement.textContent = detailsText;
                            detailsElement.style.display = 'block'; // Set initial display to block
                            this.after(detailsElement);
                            // If details are shown, remove the "..."
                            if (this.dataset.outputType === 'array' || this.dataset.outputType === 'map') {
                                this.innerHTML = this.innerHTML.replace(' = {...}', ' = {');
                                this.innerHTML = this.innerHTML.replace(' = [...]', ' = [');
                            }
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
