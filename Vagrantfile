PROVISION = <<-SCRIPT
sudo apt-get update -y
sudo apt-get install apt-transport-https \
  ca-certificates \
  curl \
  gnupg2 \
  git \
  software-properties-common \
  rsync -y
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo apt-key add -
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/debian $(lsb_release -cs) stable"
sudo apt-get update -y
sudo apt-get install -y docker-ce
[ -d /home/vagrant/.ssh ] && echo '%{public_key}' >> /home/vagrant/.ssh/authorized_keys; true
[ -d /home/vagrant/.ssh ] && chmod 600 /home/vagrant/.ssh/authorized_keys; true
git clone -b crux --single-branch https://github.com/vyos/vyos-build /opt/vyos-build
docker run --rm -t --privileged -v /opt/vyos-build:/vyos -w /vyos vyos/vyos-build:crux \
  /bin/bash -c './configure --architecture amd64 --build-by "hackerman@vyos.io" && make iso'
SCRIPT

def define_vm(config, hostname, ip)
  public_key_path = File.join(Dir.home, ".ssh", "id_rsa.pub")
  public_key = IO.read(public_key_path)

  config.vm.define hostname do |vm|
      vm.vm.box = "debian/jessie64"
      vm.vm.hostname = hostname
      vm.vm.network 'private_network', ip: ip

      vm.vm.provision :shell, inline: (PROVISION % { public_key: public_key })
  end
end

Vagrant.configure("2") do |config|
  define_vm(config, "vyos", "10.1.1.254")
  config.vm.synced_folder ".", "/vagrant", disabled: true
end
