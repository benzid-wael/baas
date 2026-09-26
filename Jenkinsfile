// Thin on purpose. Everything CI does lives in scripts/ci/ so that the
// pipeline is readable, reviewable and runnable from the repository — the
// incumbent's Jenkinsfile is two lines into a shared library, and its CI is
// therefore opaque from the code it gates (finding E2).
pipeline {
  agent { label 'nodejs' }

  options {
    timestamps()
    ansiColor('xterm')
    timeout(time: 30, unit: 'MINUTES')
  }

  environment {
    // No database service is declared: the test harness starts its own real
    // PostgreSQL, so the agent needs Node and nothing else. See New-2.
    CI = 'true'
  }

  stages {
    stage('Setup') {
      steps {
        sh 'node --version'
        sh 'corepack enable && corepack prepare pnpm@9.15.0 --activate'
        sh 'pnpm install --frozen-lockfile'
      }
    }

    stage('Verify') {
      steps {
        sh './scripts/ci/verify.sh'
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'coverage/**', allowEmptyArchive: true
    }
  }
}
