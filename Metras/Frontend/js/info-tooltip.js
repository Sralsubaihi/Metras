// info-tooltip.js - Shared "i" icon popover.
// Used for the column explanations (results.html, compare.html) and the deadline
// colour legend (project-tasks.html, member-project-tasks.html).
// Call attachInfoTooltip(icon, html) once per icon. Only one popover is open at a
// time; clicking anywhere else closes it.

// One popover element shared by all icons, and the icon currently showing it.
let sharedPopover = null;
let openIcon = null;

// Create the shared popover element on first use.
function getPopover() {
  if (sharedPopover) return sharedPopover;
  sharedPopover = document.createElement("div");
  sharedPopover.className = "info-popover";
  document.body.appendChild(sharedPopover);
  return sharedPopover;
}

// Attach a click-to-toggle popover with the given HTML to an icon.
export function attachInfoTooltip(icon, html) {
  if (!icon) return;
  icon.addEventListener("click", (event) => {
    event.stopPropagation();
    const popover = getPopover();

    // Clicking the same icon again closes the popover.
    if (openIcon === icon && popover.classList.contains("open")) {
      popover.classList.remove("open");
      openIcon = null;
      return;
    }

    popover.innerHTML = html;
    popover.classList.add("open");
    openIcon = icon;

    // Place the popover under the icon, at least 12px inside the window edges.
    const rect = icon.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();

    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 12) {
      left = window.innerWidth - popRect.width - 12;
    }
    if (left < 12) left = 12;

    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom + 6}px`;
  });
}

// A click anywhere else closes the popover.
document.addEventListener("click", () => {
  if (sharedPopover) {
    sharedPopover.classList.remove("open");
    openIcon = null;
  }
});

// Deadline colour legend shared by the leader and member task pages,
// so both always match deadlineInfo().
export const DEADLINE_LEGEND_HTML = `
  <strong>What the deadline colors mean</strong>
  <div class="legend-row"><span class="legend-swatch" style="background:#6ee7a8;"></span>Plenty of time left</div>
  <div class="legend-row"><span class="legend-swatch" style="background:#ffbd66;"></span>Getting closer — keep moving</div>
  <div class="legend-row"><span class="legend-swatch" style="background:var(--danger,#ff8a96);"></span>Due soon or overdue</div>
  <div class="legend-row"><span class="legend-swatch" style="background:var(--primary-2,#8b94e8);"></span>Task completed</div>
  <div class="legend-row"><span class="legend-swatch" style="background:#a5a8b8;"></span>No deadline set</div>
`;
