const path = require("path");
const { exec, getExecOutput } = require("@actions/exec");

const { version } = require("../package.json");
const tag = `v${version}`;

process.chdir(path.join(__dirname, ".."));

(async () => {
  const { exitCode, stderr } = await getExecOutput(
    `git`,
    ["ls-remote", "--exit-code", "origin", "--tags", `refs/tags/${tag}`],
    {
      ignoreReturnCode: true,
    },
  );
  if (exitCode === 0) {
    console.log(
      `Action is not being published because version ${tag} is already published`,
    );
    return;
  }
  if (exitCode !== 2) {
    throw new Error(`git ls-remote exited with ${exitCode}:\n${stderr}`);
  }

  await exec("changeset", ["publish"]);

  // Create and push the tag explicitly (Changesets defaults to v-prefixed tags).
  await exec("git", ["tag", tag]);
  await exec("git", ["push", "origin", tag]);
})();
