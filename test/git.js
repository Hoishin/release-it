const path = require('path');
const test = require('ava');
const sinon = require('sinon');
const sh = require('shelljs');
const mockStdIo = require('mock-stdio');
const uuid = require('uuid/v4');
const { readFile, gitAdd } = require('./util/index');
const Shell = require('../lib/shell');
const Git = require('../lib/git');

const shell = new Shell();
const gitClient = new Git();

const cwd = path.resolve(process.cwd());

test.beforeEach(t => {
  const tmp = path.join(cwd, 'tmp', uuid());
  sh.mkdir('-p', tmp);
  sh.pushd('-q', tmp);
});

test.afterEach(t => {
  sh.pushd('-q', cwd);
});

test.serial('isGitRepo', async t => {
  t.true(await gitClient.isGitRepo());
  const tmp = '../../..';
  sh.pushd('-q', tmp);
  t.false(await gitClient.isGitRepo());
  sh.popd('-q');
});

test.serial('isInGitRootDir', async t => {
  t.false(await gitClient.isInGitRootDir());
  sh.exec('git init');
  t.true(await gitClient.isInGitRootDir());
});

test.serial('hasUpstream', async t => {
  sh.exec('git init');
  gitAdd('line', 'file', 'Add file');
  t.false(await gitClient.hasUpstreamBranch());
});

test.serial('getBranchName', async t => {
  sh.exec('git init');
  t.is(await gitClient.getBranchName(), null);
  sh.exec('git checkout -b feat');
  gitAdd('line', 'file', 'Add file');
  t.is(await gitClient.getBranchName(), 'feat');
});

test.serial('tagExists + isWorkingDirClean', async t => {
  sh.exec('git init');
  t.false(await gitClient.tagExists('1.0.0'));
  sh.touch('file');
  t.false(await gitClient.isWorkingDirClean());
  gitAdd('line', 'file', 'Add file');
  sh.exec('git tag 1.0.0');
  t.true(await gitClient.tagExists('1.0.0'));
  t.true(await gitClient.isWorkingDirClean());
});

test.serial('getRemoteUrl', async t => {
  sh.exec(`git init`);
  {
    const gitClient = new Git({ pushRepo: 'origin' });
    t.is(await gitClient.getRemoteUrl(), null);
    sh.exec(`git remote add origin foo`);
    t.is(await gitClient.getRemoteUrl(), 'foo');
  }
  {
    const gitClient = new Git({ pushRepo: 'another' });
    t.is(await gitClient.getRemoteUrl(), null);
    sh.exec(`git remote add another bar`);
    t.is(await gitClient.getRemoteUrl(), 'bar');
  }
  {
    const gitClient = new Git({ pushRepo: 'git://github.com/webpro/release-it.git' });
    t.is(await gitClient.getRemoteUrl(), 'git://github.com/webpro/release-it.git');
  }
});

test.serial('clone + stage + commit + tag + push', async t => {
  const bare = `../${uuid()}`;
  sh.exec(`git init --bare ${bare}`);
  const gitClient = new Git();
  await gitClient.clone(bare, '.');
  await gitClient.init();
  const version = '1.2.3';
  gitAdd(`{"version":"${version}"}`, 'package.json', 'Add package.json');
  {
    sh.exec(`git tag ${version}`);
    const latestTag = await gitClient.getLatestTag();
    t.true(await gitClient.isGitRepo());
    t.is(version, latestTag);
  }
  {
    gitAdd('line', 'file', 'Add file');
    sh.exec('npm --no-git-tag-version version patch');
    await gitClient.stage('package.json');
    await gitClient.commit({ message: `Release v1.2.4` });
    await gitClient.tag({ name: 'v1.2.4', annotation: 'Release v1.2.4' });
    t.is(await gitClient.getLatestTag(), '1.2.4');
    await gitClient.push();
    const status = sh.exec('git status -uno');
    t.true(status.includes('nothing to commit'));
  }
});

test.serial('push', async t => {
  const bare = `../${uuid()}`;
  sh.exec(`git init --bare ${bare}`);
  sh.exec(`git clone ${bare} .`);
  const gitClient = new Git({ shell });
  await gitClient.init();
  gitAdd('line', 'file', 'Add file');
  const spy = sinon.spy(shell, 'run');
  await gitClient.push();
  t.is(spy.lastCall.args[0].trim(), 'git push --follow-tags  origin');
  const actual = sh.exec('git ls-tree -r HEAD --name-only', { cwd: bare });
  t.is(actual.trim(), 'file');
  spy.restore();
});

test.serial('push (pushRepo url)', async t => {
  const bare = `../${uuid()}`;
  sh.exec(`git init --bare ${bare}`);
  sh.exec(`git clone ${bare} .`);
  const gitClient = new Git({ pushRepo: 'https://host/repo.git', shell });
  await gitClient.init();
  gitAdd('line', 'file', 'Add file');
  const spy = sinon.spy(shell, 'run');
  try {
    await gitClient.push();
  } catch (err) {
    t.is(spy.lastCall.args[0].trim(), 'git push --follow-tags  https://host/repo.git');
  }
  spy.restore();
});

test.serial('push (pushRepo not "origin")', async t => {
  const bare = `../${uuid()}`;
  sh.exec(`git init --bare ${bare}`);
  sh.exec(`git clone ${bare} .`);
  const gitClient = new Git();
  await gitClient.init();
  sh.exec(`git remote add upstream ${sh.exec('git remote get-url origin')}`);
  {
    const gitClient = new Git({ pushRepo: 'upstream', shell });
    gitAdd('line', 'file', 'Add file');
    const spy = sinon.spy(shell, 'run');
    await gitClient.push();
    t.is(spy.lastCall.args[0].trim(), 'git push --follow-tags  upstream');
    const actual = sh.exec('git ls-tree -r HEAD --name-only', { cwd: bare });
    t.is(actual.trim(), 'file');
    {
      sh.exec(`git checkout -b foo`);
      gitAdd('line', 'file', 'Add file');
      await gitClient.push();
      t.is(spy.lastCall.args[0].trim(), 'git push --follow-tags  -u upstream foo');
      t.is(await spy.lastCall.returnValue, "Branch 'foo' set up to track remote branch 'foo' from 'upstream'.");
    }
    spy.restore();
  }
});

test.serial('status', async t => {
  sh.exec('git init');
  gitAdd('line', 'file1', 'Add file');
  sh.ShellString('line').toEnd('file1');
  sh.ShellString('line').toEnd('file2');
  sh.exec('git add file2');
  t.is(await gitClient.status(), 'M file1\nA  file2');
});

test.serial('reset', async t => {
  sh.exec('git init');
  gitAdd('line', 'file', 'Add file');
  sh.ShellString('line').toEnd('file');
  t.regex(await readFile('file'), /^line\s*line\s*$/);
  await gitClient.reset('file');
  t.regex(await readFile('file'), /^line\s*$/);
  mockStdIo.start();
  await gitClient.reset(['file2, file3']);
  const { stdout } = mockStdIo.end();
  t.regex(stdout, /Could not reset file2, file3/);
});

test.serial('getChangelog', async t => {
  sh.exec('git init');
  gitAdd('line', 'file', 'First commit');
  gitAdd('line', 'file', 'Second commit');
  await t.throwsAsync(gitClient.getChangelog('git log --invalid'), { message: /Could not create changelog/ });
  {
    const changelog = await gitClient.getChangelog('git log --pretty=format:"* %s (%h)"');
    t.regex(changelog, /^\* Second commit \(\w{7}\)\n\* First commit \(\w{7}\)$/);
  }
  {
    sh.exec('git tag 1.0.0');
    gitAdd('line', 'file', 'Third commit');
    gitAdd('line', 'file', 'Fourth commit');
    const changelog = await gitClient.getChangelog('git log --pretty=format:"* %s (%h)" [REV_RANGE]');
    t.regex(changelog, /^\* Fourth commit \(\w{7}\)\n\* Third commit \(\w{7}\)$/);
  }
});

test.serial('getChangelog (custom)', async t => {
  sh.pushd('-q', '../..');
  const changelog = await gitClient.getChangelog('echo ${name}');
  t.is(changelog, 'release-it');
});

test.serial('isSameRepo', async t => {
  const gitClient = new Git();
  await gitClient.init();
  const otherClient = new Git();
  await otherClient.init();
  t.true(gitClient.isSameRepo(otherClient));
  {
    const bare = `../${uuid()}`;
    sh.exec(`git init --bare ${bare}`);
    sh.exec(`git clone ${bare} .`);
    const otherClient = new Git();
    await otherClient.init();
    t.false(gitClient.isSameRepo(otherClient));
  }
});
