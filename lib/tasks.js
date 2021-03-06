const { EOL } = require('os');
const Logger = require('./log');
const Config = require('./config');
const Shell = require('./shell');
const Git = require('./git');
const GitDist = require('./git-dist');
const GitHub = require('./github');
const GitLab = require('./gitlab');
const npm = require('./npm');
const Version = require('./version');
const Changelog = require('./changelog');
const prompt = require('./prompt');
const Spinner = require('./spinner');
const Metrics = require('./metrics');
const { logPreview } = require('./util');
const { debug } = require('./debug');
const handleDeprecated = require('./deprecated');

module.exports = async opts => {
  const config = new Config(opts);

  const { isInteractive, isVerbose, isDryRun, isDebug } = config;
  const log = new Logger({ isInteractive, isVerbose, isDryRun });
  const metrics = new Metrics({ isEnabled: config.isCollectMetrics });
  const s = new Spinner({ isInteractive, isVerbose, isDryRun, isDebug });

  try {
    const options = handleDeprecated(config.getOptions());

    metrics.trackEvent('start', options);

    const { name, dist, use, pkgFiles, scripts } = options;
    const { beforeStart, beforeBump, afterBump, beforeStage } = scripts;

    const shell = new Shell({ isVerbose, isDryRun, log, config });
    const gitClient = new Git(options.git, { log, shell });
    const gitDistClient = new GitDist(options.git, dist.git, dist, { log, shell });
    let changelog;
    const changelogs = new Changelog({ shell });

    await gitClient.init();
    await gitClient.validate();
    gitDistClient.validate();

    const { latestTag, isRootDir } = gitClient;

    const remoteUrl = gitClient.remoteUrl;
    const run = shell.runTemplateCommand.bind(shell);

    const ghClient = new GitHub(options.github, options.git, { isDryRun, log, changelogs, remoteUrl });
    const glClient = new GitLab(options.gitlab, options.git, { isDryRun, log, changelogs, remoteUrl });
    const npmClient = new npm(options.npm, { isDryRun, shell, log });

    ghClient.validate();
    glClient.validate();

    const getChangelog = async () => {
      const changelog = await changelogs.create(scripts.changelog, latestTag);
      logPreview(log, 'changelog', changelog, !v.version && EOL);
      return changelog;
    };

    await s.show({ enabled: beforeStart, task: () => run(beforeStart), label: beforeStart, forced: true });

    const v = new Version({ preReleaseId: options.preReleaseId, log });
    v.setLatestVersion({ use, gitTag: latestTag, pkgVersion: options.npm.version, isRootDir });
    await v.bump({ increment: options.increment, preRelease: options.preRelease });

    config.setRuntimeOptions(v.details);
    const { latestVersion } = v;

    const suffix = v.version ? `${latestVersion}...${v.version}` : `currently at ${latestVersion}`;
    log.log(`${EOL}🚀 Let's release ${name} (${suffix})`);

    // TODO: don't use class-in-class
    const isLateChangeLog = v.recs.isRecommendation(options.increment);
    if (!isLateChangeLog) {
      changelog = await getChangelog();
      config.setRuntimeOptions({ changelog });
    }

    if (isInteractive && !v.version) {
      const context = config.getOptions();
      await prompt(true, context, 'incrementList', async increment => {
        if (increment) {
          await v.bump({ increment });
        } else {
          await prompt(true, context, 'version', async version => {
            v.version = version;
          });
        }
      });
    }

    v.validate();
    config.setRuntimeOptions(v.details);
    const { version, isPreRelease } = v.details;

    if (isInteractive && pkgFiles && options.git.requireCleanWorkingDir) {
      process.on('SIGINT', () => gitClient.reset(pkgFiles));
      process.on('exit', () => gitClient.reset(pkgFiles));
    }

    await s.show({ enabled: beforeBump, task: () => run(beforeBump), label: beforeBump, forced: true });
    await s.show({ task: () => shell.bump(pkgFiles, version), label: 'Bump version' });
    await s.show({ enabled: afterBump, task: () => run(afterBump), label: afterBump, forced: true });

    if (isLateChangeLog) {
      changelog = await getChangelog();
      config.setRuntimeOptions({ changelog });
    }

    await s.show({ enabled: beforeStage, task: () => run(beforeStage), label: beforeStage, forced: true });
    await gitClient.stage(pkgFiles);
    await gitClient.stageDir();

    if (options.dist.repo) {
      const { scripts, repo, stageDir, files, baseDir, pkgFiles } = options.dist;
      const { beforeStage } = scripts;
      await s.show({ task: () => gitDistClient.clone(repo, stageDir), label: 'Clone' });
      await shell.copy(files, stageDir, { cwd: baseDir });
      await shell.pushd(stageDir);
      await shell.bump(pkgFiles, version);
      await s.show({ enabled: beforeStage, task: () => run(beforeStage), label: beforeStage, forced: true });
      await gitDistClient.stageDir();
      await shell.popd();
    }

    const release = async ({ gitClient, ghClient, glClient, npmClient, scripts }) => {
      const { afterRelease } = scripts;
      const git = gitClient.options;
      const github = ghClient.options;
      const gitlab = glClient.options;
      const npm = npmClient.options;
      const context = Object.assign(config.getOptions(), { git, github, gitlab, npm });

      const commit = () => gitClient.commit();
      const tag = () => gitClient.tag();
      const push = () => gitClient.push();
      const ghRelease = () => ghClient.release({ version, isPreRelease, changelog });
      const ghUploadAssets = () => ghClient.uploadAssets();
      const ghReleaseAndUploadAssets = async () => (await ghRelease()) && (await ghUploadAssets());
      const glRelease = () => glClient.release({ version, changelog });
      const otpPrompt = isInteractive && (task => prompt(true, context, 'otp', task));
      const publish = () => npmClient.publish({ version, isPreRelease, otpPrompt });

      logPreview(log, 'changeset', await gitClient.status(), EOL);

      if (!isInteractive) {
        await s.show({ enabled: git.commit, task: commit, label: 'Git commit' });
        await s.show({ enabled: git.tag, task: tag, label: 'Git tag' });
        await s.show({ enabled: git.push, task: push, label: 'Git push' });
        github.release && github.releaseNotes && logPreview(log, 'release notes', await ghClient.getNotes(), EOL);
        await s.show({ enabled: github.release, task: ghRelease, label: 'GitHub release' });
        await s.show({ enabled: github.assets, task: ghUploadAssets, label: 'GitHub upload assets' });
        gitlab.release && gitlab.releaseNotes && logPreview(log, 'release notes', await glClient.getNotes(), EOL);
        await s.show({ enabled: gitlab.release, task: glRelease, label: 'GitLab release' });
        await s.show({ enabled: npm.publish && !npm.private, task: publish, label: 'npm publish' });
      } else {
        await prompt(git.commit, context, 'commit', commit);
        await prompt(git.tag, context, 'tag', tag);
        await prompt(git.push, context, 'push', push);
        github.release && github.releaseNotes && logPreview(log, 'release notes', await ghClient.getNotes(), EOL);
        await prompt(github.release, context, 'ghRelease', ghReleaseAndUploadAssets);
        gitlab.release && gitlab.releaseNotes && logPreview(log, 'release notes', await glClient.getNotes(), EOL);
        await prompt(gitlab.release, context, 'glRelease', glRelease);
        await prompt(npm.publish && !npm.private, context, 'publish', publish);
      }

      await s.show({ enabled: afterRelease, task: () => run(afterRelease), label: afterRelease, forced: true });

      ghClient.isReleased && log.log(`🔗 ${ghClient.getReleaseUrl()}`);
      glClient.isReleased && log.log(`🔗 ${glClient.getReleaseUrl()}`);
      npmClient.isPublished && log.log(`🔗 ${npmClient.getPackageUrl()}`);
    };

    await release({ gitClient, ghClient, glClient, npmClient, scripts });

    if (options.dist.repo) {
      const { stageDir, scripts } = options.dist;

      log.log(`${EOL}🚀 Let's release the distribution repo for ${name}`);

      const ghDistClientOptions = [options.github, dist.github, options.git, dist.git];
      const glDistClientOptions = [options.gitlab, dist.gitlab, options.git, dist.git];
      const ghDistClient = new GitHub(...ghDistClientOptions, { isDryRun, log, changelogs, remoteUrl });
      const glDistClient = new GitLab(...glDistClientOptions, { isDryRun, log, changelogs, remoteUrl });
      const npmDistClient = new npm(options.npm, dist.npm, { isDryRun, shell, log });

      ghDistClient.validate();
      glDistClient.validate();

      await shell.pushd(stageDir);

      await gitDistClient.init();
      gitDistClient.handleTagOptions(gitClient);

      await release({
        gitClient: gitDistClient,
        ghClient: ghDistClient,
        glClient: glDistClient,
        npmClient: npmDistClient,
        scripts
      });
      await shell.popd();
      await run(`!rm -rf ${stageDir}`);
    }

    await metrics.trackEvent('end');

    log.log(`🏁 Done (in ${Math.floor(process.uptime())}s.)`);

    return Promise.resolve({
      name,
      changelog,
      latestVersion,
      version
    });
  } catch (err) {
    await metrics.trackException(err);
    log.error(err.message || err);
    debug(err);
    throw err;
  }
};
