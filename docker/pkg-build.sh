if [ -z "$1" ]; then
    RELEASE=`echo $GIT_BRANCH | sed 's/origin\//* /g' |sed -n 's/^\* \(.*\)$/\1/p'`
else
    RELEASE="$1"
fi

if [ "$RELEASE" == "master" ]; then
    RELEASE="current"
fi

if [ -n "$1" ]; then
    RELEASE="$1"
fi

ARCH=`dpkg --print-architecture`
VYOS_REPO_PATH="/home/sentrium/web/dev.packages.vyos.net/public_html/repositories/$RELEASE/vyos/"

exit_code () {
rc=$?
if [[ $rc != 0 ]] ; then
    exit $rc
fi
}

echo $RELEASE

ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no khagen@dev.packages.vyos.net -t "bash --login -c 'mkdir -p ~/VyOS/$RELEASE/$ARCH'"
exit_code

scp -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no  ../*.deb khagen@dev.packages.vyos.net:~/VyOS/$RELEASE/$ARCH/
exit_code

for PACKAGE in `ls ../*.deb`;
do
  PACKAGE=`echo $PACKAGE| cut -d'/' -f 2`
  SUBSTRING=`echo $PACKAGE| cut -d'_' -f 1`
  if [[ "$PACKAGE" == *_all* ]]; then
    ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no khagen@dev.packages.vyos.net -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} remove ${RELEASE} ${SUBSTRING}'"
    exit_code
  else
    ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no khagen@dev.packages.vyos.net -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} -A $ARCH remove $RELEASE $SUBSTRING'"
    exit_code
  fi
  ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no khagen@dev.packages.vyos.net -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} deleteunreferenced'"
  exit_code
  if [[ "$PACKAGE" == *_all* ]]; then
    ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no khagen@dev.packages.vyos.net -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} includedeb $RELEASE ~/VyOS/$RELEASE/$ARCH/$PACKAGE'"
    exit_code
  else
    ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no khagen@dev.packages.vyos.net -t "uncron-add 'reprepro -v -b ${VYOS_REPO_PATH} -A $ARCH includedeb $RELEASE ~/VyOS/$RELEASE/$ARCH/$PACKAGE'"
    exit_code
  fi
done

rm -f ../*.deb
