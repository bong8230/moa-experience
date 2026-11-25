// Product-Seeding-Automation CI for the local Windows Jenkins (http://127.0.0.1:18080).
// Default run = checks + tests only. Deployment needs ALL of:
//   1. DEPLOY_VERCEL=true and CONFIRM_DEPLOY=DEPLOY (explicit build parameters)
//   2. docs/vercel-readiness.json "ready": true (currently false: see docs/deployment.md)
//   3. a build of the main branch
//   4. Vercel CLI authentication in the Windows account running Jenkins (never stored in this repo)
//   5. a manual approval click for production
pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    timeout(time: 20, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    booleanParam(name: 'DEPLOY_VERCEL', defaultValue: false, description: 'Deploy to Vercel after tests. Blocked until docs/vercel-readiness.json says ready.')
    choice(name: 'VERCEL_TARGET', choices: ['preview', 'production'], description: 'Vercel environment (production asks for approval).')
    string(name: 'CONFIRM_DEPLOY', defaultValue: '', description: 'Type DEPLOY to confirm a deployment.', trim: true)
  }

  environment {
    // Pinned CLI version (latest on npm as of 2026-11-13, `npm view vercel version`).
    // Update deliberately after checking the release notes.
    VERCEL_CLI = 'vercel@65.15.0'
  }

  stages {
    stage('Environment') {
      steps {
        bat '@node --version'
        // node --test with a glob pattern needs Node 21+; the app uses process.loadEnvFile (20.12+)
        bat '@node -e "const m=+process.versions.node.split(\'.\')[0]; if (m < 22) { console.error(\'Node 22+ required, found \' + process.version); process.exit(1) }"'
      }
    }

    stage('Secret guard') {
      steps {
        script {
          def tracked = bat(returnStdout: true, script: '@git ls-files -- preview/.env preview/data .env').trim()
          if (tracked) {
            error("Secret or runtime files are tracked by git; remove them from the index:\n${tracked}")
          }
        }
      }
    }

    stage('Dependencies') {
      steps {
        bat '@npm ci --ignore-scripts --no-audit --no-fund'
      }
    }

    stage('Test') {
      steps {
        // unit + API tests; no network, Kakao and the data source are mocked
        bat '@node --test preview/*.test.js'
      }
    }

    stage('Deploy readiness') {
      when { expression { return params.DEPLOY_VERCEL } }
      steps {
        script {
          if (params.CONFIRM_DEPLOY != 'DEPLOY') {
            error('Deployment not confirmed: set CONFIRM_DEPLOY=DEPLOY.')
          }
          def branch = (env.BRANCH_NAME ?: env.GIT_BRANCH ?: '').replaceFirst('^origin/', '')
          if (branch != 'main') {
            error("Deployments run only from main (this build: '${branch}').")
          }
        }
        // fails while docs/vercel-readiness.json has "ready": false and prints the blockers
        bat '@node -e "const r=require(\'./docs/vercel-readiness.json\'); if (r.ready !== true) { console.error(\'Vercel deployment is not ready:\'); for (const b of r.blockers || []) console.error(\' - \' + b); process.exit(1) }"'
      }
    }

    stage('Approve production') {
      when {
        beforeInput true
        expression { return params.DEPLOY_VERCEL && params.VERCEL_TARGET == 'production' }
      }
      input {
        message 'Deploy this build to Vercel production?'
        ok 'Deploy'
      }
      steps {
        echo 'Production deployment approved.'
      }
    }

    stage('Deploy to Vercel') {
      when { expression { return params.DEPLOY_VERCEL } }
      steps {
        script {
          if (!env.VERCEL_ORG_ID?.trim() || !env.VERCEL_PROJECT_ID?.trim()) {
            error('Set VERCEL_ORG_ID and VERCEL_PROJECT_ID in the Jenkins environment.')
          }
          def prod = params.VERCEL_TARGET == 'production' ? ' --prod' : ''
          // CLI refreshes the user's OAuth session without copying tokens into this repository or Jenkins.
          bat '@npx --yes %VERCEL_CLI% whoami'
          bat "@npx --yes %VERCEL_CLI% deploy --yes${prod}"
        }
      }
    }
  }

  post {
    always {
      echo "Result: ${currentBuild.currentResult}"
    }
  }
}
