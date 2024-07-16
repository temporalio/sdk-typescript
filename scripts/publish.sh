#!/bin/zsh
set -euo pipefail

local workdir=$( mktemp -d -t sdk-typescript-release )
trap 'cd / && rm -rf "$workdir"' EXIT
cd "$workdir"

# FIXME Make this a parameter
# e.g. 'main' or 'releases/1.10.x'
source_branch=main

# Manually download all native artifacts from the latest main build

mkdir -p artifacts package/releases
open artifacts

echo -e 'Please do the following:'
echo -e ' 1. Open the \e]8;;https://github.com/temporalio/sdk-typescript/actions/workflows/ci.yml?query=branch%3Amain\e\\GHA status page\e]8;;\e\\ for the "Continuous Integration" workflow, on branch main.'
echo -e ' 2. From there, select the latest execution'
echo -e ' 3. Download all corebridge-native-* artifacts to the "artifacts" directory that just opened'

echo
echo -e 'Press ENTER once this is completed.'
read enterKey

local count=$( find artifacts -type f -name "corebridge-native-*.zip" | wc -l )
if [ $count -ne 5 ]; then
    echo "The 'artifacts' directory does not contain exactly 5 files named 'corebridge-native-*.zip'"
    echo "Aborting"
    exit 1
fi

git clone --branch $source_branch --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/sdk-typescript.git
cd sdk-typescript

# Extract native libs and organize them correctly
for name in ../artifacts/*.zip ; do
    unzip -q ${name} -d packages/core-bridge/releases/
done

npm ci  --ignore-scripts
npm run build -- --ignore @temporalio/core-bridge

echo
echo 'Does this look correct?'
echo
ls -l packages/core-bridge/releases/*/*

echo
echo 'Press ENTER to go on with publishing, or Ctrl+C to abort'

read enterKey

echo 'Publishing...'

# User will be asked to indicate which type of release and to confirm,
# then the Publish commit will be created and pushed to the main branch.
npx lerna version --force-publish='*'

local version=$( jq -r '.version' < lerna.json )

git checkout -B fix-deps
node scripts/prepublish.mjs
git commit -am 'Fix dependencies'

# Check if the version matches the pattern
if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
    npx lerna publish from-package
else
    npx lerna publish from-package --dist-tag next
fi

npm deprecate "temporalio@^${version}" "Instead of installing temporalio, we recommend directly installing our packages: npm remove temporalio; npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity"

echo -e 'Please do the following:'
echo -e ' 1. Open the \e]8;https://github.com/temporalio/sdk-typescript/releases/new?tag=v'"$version"'\e\\GitHub New Release page\e]8;;\e\\ and select the '"$version"' tag.'
echo -e ' 2. In the Release Title field, enter '"$version"''
echo -e ' 3. Paste the release notes inkto the description field'
if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
    echo -e ' 4. Make sure that the "Set as a pre-release" checkbox is unchecked'
    echo -e '    and that the "Set as the latest release" checkbox is checked'
else
    echo -e ' 4. Make sure that the "Set as a pre-release" checkbox is checked'
    echo -e '    and that the "Set as the latest release" checkbox is unchecked'
fi
echo -e ' 5. Press the "Save draft" button, then ask someone else to review'
echo -e ' 6. Press the "Publish Release" buton to complete the release process'

echo
echo -e 'Press ENTER once this is completed.'
read enterKey

cd "$workdir"

if [[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then

  ##
  # Update the features repo
  ##

  (
    git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/features.git
    cd features

    # Update typescript_latest in ci.yaml
    sed -i '' 's%^\([ ]*typescript_latest: \).*$%\1'"'$version'"'%' .github/workflows/ci.yaml

    # Update @temporalio/* dependencies in package.json
    sed -i '' 's#\("@temporalio/.*": "^\)[^"]*\(",\)#\1'"$version"'\2#' package.json

    # Update package-lock.json
    npm i

    git checkout -b "typescript-${version}"
    git add --all
    git commit -m "Update TS SDK to ${version}"

    gh pr create \
        --title "Update TS SDK to ${version}" \
        --body "## What changed"$'\n\n'"- Update TS SDK to ${version}" \
        --head "typescript-${version}"
  )

  ##
  # Update the samples repo
  ##

  (
    git clone --depth 1 --shallow-submodules --recurse-submodules https://github.com/temporalio/samples-typescript.git
    cd samples-typescript

    npm i

    # Update all samples
    zx .scripts/upgrade-versions.mjs "^1.10.2"

    # Update the package.json file
    npm i

    git checkout -b "typescript-${version}"
    git add --all
    git commit -m "Update TS SDK to ${version}"
    git push

    gh pr create \
        --title "Update TS SDK to ${version}" \
        --body "## What changed"$'\n\n'"- Update TS SDK to ${version}" \
        --head "typescript-${version}"
  )
fi