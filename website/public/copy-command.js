// SPDX-License-Identifier: Apache-2.0
const copyButton = document.querySelector("[data-copy-button]");
const copyLabel = document.querySelector("[data-copy-label]");
const copyStatus = document.querySelector("[data-copy-status]");
const command = document.querySelector("[data-install-command]");

if (copyButton && copyLabel && copyStatus && command) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    const commandText = command.textContent?.trim() ?? "";

    try {
      await navigator.clipboard.writeText(commandText);
      copyLabel.textContent = "Copied";
      copyStatus.textContent = "Install command copied.";
      copyButton.dataset.state = "success";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(command);
      selection?.removeAllRanges();
      selection?.addRange(range);
      copyLabel.textContent = "Copy failed";
      copyStatus.textContent = "Couldn’t copy. Select the command and copy it manually.";
      copyButton.dataset.state = "failure";
    }

    copyButton.focus();
    window.setTimeout(() => {
      copyLabel.textContent = "Copy command";
      delete copyButton.dataset.state;
    }, 2000);
  });
}
