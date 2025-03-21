# Terraform Plan Summarizer

A Visual Studio Code extension to summarize Terraform plan outputs.

## Features

-   Summarizes Terraform plan outputs, highlighting resources to be created, updated, or destroyed.
-   Provides detailed information about each resource change.
-   Supports summarizing plan outputs from the active editor, selected text, or clipboard.

## Usage

1.  Open a Terraform plan output in Visual Studio Code.
2.  Run the `Terraform Plan Summarizer: Summarize` command from the command palette (Ctrl+Shift+P or Cmd+Shift+P).
    *   The extension will attempt to read the plan from:
        *   The current text selection
        *   The current editor
        *   The clipboard
    *   The extension will display a summary in a webview panel.
3.  Alternatively, use the `Terraform Plan Summarizer: Summarize In Place` command to format the plan directly in the editor.
    *   This will reformat the current editor window to show a simplified plan.

## Extension Settings

There are no settings for this extension.

## Known Issues

-   None
