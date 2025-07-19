# Change Log

## 1.0.3
- Fix detecting changes for "must be replaced" resources that have spaces in Terraform address

## 1.0.2
- Fix detecting changes for the same resource address in "changes outside terraform" and changes in plan
- Fix clicking on "CHANGES OUTSIDE TERRAFORM" title to expand/collapse all item details

## 1.0.1

- Fix "must be replaced" capturing

## 1.0.0

- Add support for changes outside of Terraform
- Add support for output changes

## 0.3.3

- Clean up package

## 0.3.1

- Fix collapsing in Editor summary
- Fix display of "is tainted, must be replaced" resources

## 0.3.0

- Refactor inplace summary to read the same source as webview
- For inplace summary, open a new tab instead of doing replacement
- Rename inplace summary to "in Editor"

## 0.2.0

- Add context menu for `.plan` or `.tfplan` files
- Group resource changes for in-place summary

## 0.1.1

- Prevent wrap text if line is too long (webview)

## 0.1.0

- Add support for binary plan file

## 0.0.2

- Fix detecting "to be destroyed" resources

## 0.0.1

- Initial release
