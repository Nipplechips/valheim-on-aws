# Dockerfile for development environment
FROM amazonlinux:2023
RUN dnf install -y dnf-utils git tar gcc \
                   zlib-devel bzip2-devel readline-devel \
                   sqlite sqlite-devel openssl-devel \
                   tk-devel libffi-devel xz-devel

RUN curl https://pyenv.run | bash && \
    echo 'export PYENV_ROOT="$HOME/.pyenv"' >> ~/.bashrc && \
    echo '[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"' >> ~/.bashrc && \
    echo 'eval "$(pyenv init -)"' >> ~/.bashrc && \
    source ~/.bashrc && \
    pyenv install 3.12.4 && \
    pyenv global 3.12.4

RUN dnf install -y nodejs npm
RUN npm i -g aws-cdk

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
RUN unzip awscliv2.zip
RUN ./aws/install

RUN dnf config-manager --add-repo https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
RUN dnf -y install terraform
