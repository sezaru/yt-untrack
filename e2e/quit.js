// Cleanly end the current session (closes Firefox, frees geckodriver's session slot).
const fs = require("fs");
const path = require("path");
const { WebDriver, Session } = require("selenium-webdriver");
const http = require("selenium-webdriver/http");
try {
  const sid = fs.readFileSync(path.join(__dirname, "session.txt"), "utf8").trim();
  const executor = new http.Executor(new http.HttpClient("http://localhost:4444"));
  new WebDriver(new Session(sid, {}), executor)
    .quit().then(() => console.log("session quit")).catch((e) => console.log("quit err (ok):", e.message));
} catch (e) {
  console.log("no session to quit");
}
