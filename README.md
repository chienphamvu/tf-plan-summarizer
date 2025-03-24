# Terraform Plan Summarizer

A Visual Studio Code extension to summarize Terraform plan outputs in a more readable way, especially if your plan is long and has a lot of changes.

## Features

-   Summarizes Terraform plan outputs, highlighting resources to be created, updated, or destroyed.
-   Supports summarizing plan outputs from the active editor, selected text, or clipboard.

## Usage

1.  Run the `Terraform Plan Summarizer: Summarize` command from the command palette (Ctrl+Shift+P or Cmd+Shift+P).
    *   The extension will attempt to read the plan from:
        *   The current text selection
        *   The current editor
        *   The clipboard
        *   The current open file as a binary plan
    *   The extension will display a summary in a webview panel.
2.  Alternatively, use the `Terraform Plan Summarizer: Summarize In Place` command to format the plan directly in the editor.
    *   For this, the extension does not support to read the plan from the clipboard since it needs to do in-place replacement.
    *   This will reformat the current editor window to show a simplified plan with all details collapsed.

## Extension Settings

There are no settings for this extension.

## Known Issues

-   None
