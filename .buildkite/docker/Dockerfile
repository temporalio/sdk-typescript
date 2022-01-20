FROM rust:1.58

# INSTALL NODE ============================================================================
# Unfortunately can't use the friendly lts name here easily, because then it gets hard to add to the
# path. We'll just have to update this as needed.
ENV NODE_VERSION="v16.13.0"
RUN curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.38.0/install.sh | bash
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm use ${NODE_VERSION}
ENV PATH="/root/.nvm/versions/node/${NODE_VERSION}/bin/:${PATH}"
# INSTALL NODE ============================================================================

RUN rustup component add rustfmt && \
	rustup component add clippy

WORKDIR /sdk-typescript
