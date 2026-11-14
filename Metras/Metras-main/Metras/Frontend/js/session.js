// session.js - Shared sign-out and role-based page guard used by every page script.
//
// requireRole(auth, db, allowedRoles) runs once the signed-in user is known:
//   - nobody signed in                       -> login page
//   - no record in 'users' or account disabled -> signed out, back to login page
//   - role not allowed on this page          -> sent to the user's own home page
// setupLogout() makes every logout control sign out of Firebase, clear the
// session data cached in the browser, and return to the login page.

import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

// Home page of each role (used when a user opens a page their role cannot use).
const HOME_BY_ROLE = {
  admin: "admin-dashboard.html",
  leader: "projects.html",
  team_member: "projects.html",
};

// Browser storage keys that hold project data; the theme preference is kept.
const CACHED_KEYS = ["metras_current_project", "metras_project_results"];

// Sign out, clear cached session data and go to the login page.
export async function logout() {
  try {
    await signOut(getAuth());
  } catch (error) {
    console.error("Sign-out failed:", error);
  }
  try {
    sessionStorage.clear();
    CACHED_KEYS.forEach(key => localStorage.removeItem(key));
  } catch (error) {
    console.warn("Could not clear browser storage:", error);
  }
  window.location.href = "login.html";
}

// Attach logout() to the top-bar link, the drawer link and any .logout-link.
export function setupLogout() {
  const bind = () => {
    document.querySelectorAll("#navLogout, #drawerLogout, .logout-link").forEach(link => {
      if (link.dataset.logoutBound) return;
      link.dataset.logoutBound = "true";
      link.addEventListener("click", event => {
        event.preventDefault();
        logout();
      });
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
}

// Resolve with { user, profile } when the signed-in user may use this page;
// otherwise redirect (the promise then never resolves, so page code does not run).
export function requireRole(auth, db, allowedRoles) {
  return new Promise(resolve => {
    const stop = onAuthStateChanged(auth, async user => {
      stop();
      if (!user) {
        window.location.href = "login.html";
        return;
      }
      try {
        const email = String(user.email || "").toLowerCase();
        const snap = await getDocs(query(collection(db, "users"), where("email", "==", email)));
        const profile = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };

        if (!profile || profile.isActive === false) {
          await logout();
          return;
        }
        if (!allowedRoles.includes(profile.role)) {
          alert("Access denied: your role cannot open this page.");
          window.location.href = HOME_BY_ROLE[profile.role] || "login.html";
          return;
        }
        resolve({ user, profile });
      } catch (error) {
        console.error("Role check failed:", error);
        await logout();
      }
    });
  });
}
