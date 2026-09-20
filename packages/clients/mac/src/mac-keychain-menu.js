// Native request selection, not a second credential-authorization dialog.
// The destination remains visible before any Keychain lookup. Apple alone
// supplies the credential access prompt, according to the item's existing ACL.
function requestMenuTemplate(options, choose) {
  const details = options.detail.split("\n").flatMap((line) => {
    if (!line) return [{ type: "separator" }];
    // Native menus can clip long labels. Split by Unicode code point so the
    // full URL and body remain inspectable, including at laptop screen widths.
    const chars = Array.from(line);
    const rows = [];
    for (let i = 0; i < chars.length; i += 64) {
      rows.push({
        label: `${i ? "  " : ""}${chars.slice(i, i + 64).join("")}`,
        enabled: false,
      });
    }
    return rows;
  });
  return [
    ...details,
    { type: "separator" },
    { label: "Use once…", click: () => choose(1) },
    { label: "Cancel", click: () => choose(0) },
  ];
}

function showKeychainRequestMenu(
  target,
  options,
  { Menu } = require("electron"),
) {
  return new Promise((resolve) => {
    let response = 0;
    const menu = Menu.buildFromTemplate(
      requestMenuTemplate(options, (value) => {
        response = value;
      }),
    );
    menu.popup({ window: target, callback: () => resolve({ response }) });
  });
}

module.exports = { showKeychainRequestMenu, requestMenuTemplate };
