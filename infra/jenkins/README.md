# Local Jenkins

Jenkins runs on this Windows PC at <http://127.0.0.1:18080/>. The controller only listens on loopback. The PC must remain on for builds to run.

The runtime, Jenkins home, plugins, credentials and logs live outside this repository:

`%LOCALAPPDATA%\Product-Seeding-Automation\jenkins`

Portable Eclipse Temurin Java 25 runs Jenkins without changing the existing Java installation or global PATH. The Jenkins WAR and Java archive are downloaded from their official distributors and checked against their published SHA-256 hashes.

Start or stop from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\infra\jenkins\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\infra\jenkins\stop.ps1
```

For first setup, open the URL and read the password locally from:

`%LOCALAPPDATA%\Product-Seeding-Automation\jenkins\home\secrets\initialAdminPassword`

Keep setup wizard, authentication and CSRF protection enabled. Create the administrator account in the browser. Never commit Jenkins home, initial password, tokens or logs. Install Pipeline and Git plugins before creating a pipeline from the project repository. Store deployment credentials in Jenkins Credentials, not in `Jenkinsfile`.

This installation is not a Windows service and does not start automatically after a reboot.
