#!/bin/bash

# JimiHub管理脚本
# 版本: 1.0

# 定义颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 定义路径
INSTALL_DIR="/opt/jimihub"
SCRIPT_PATH="/usr/local/bin/jimihub"

# 显示ASCII图案
show_ascii() {
    echo -e "${BLUE}"
    cat << 'EOF'
      ██╗██╗███╗   ███╗██╗██╗  ██╗██╗   ██╗██████╗ 
      ██║██║████╗ ████║██║██║  ██║██║   ██║██╔══██╗
      ██║██║██╔████╔██║██║███████║██║   ██║██████╔╝
 ██   ██║██║██║╚██╔╝██║██║██╔══██║██║   ██║██╔══██╗
 ╚█████╔╝██║██║ ╚═╝ ██║██║██║  ██║╚██████╔╝██████╔╝
  ╚════╝ ╚═╝╚═╝     ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ 
EOF
    echo -e "${NC}"
}

# 显示欢迎信息
show_welcome() {
    clear
    show_ascii
    echo -e "${GREEN}欢迎使用JimiHub管理脚本${NC}"
    echo -e "${YELLOW}================================================${NC}"
    echo ""
}

# 检查是否为root用户
check_root() {
    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}错误：此脚本需要root权限运行${NC}"
        exit 1
    fi
}

# 检查安装状态
check_install_status() {
    if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
        echo -e "${GREEN}✓ JimiHub已安装${NC}"
        INSTALLED=true
    else
        echo -e "${RED}✗ JimiHub未安装${NC}"
        INSTALLED=false
    fi
}

# 检查容器运行状态
check_container_status() {
    if [ "$INSTALLED" = true ]; then
        if docker ps | grep -q "jimihub"; then
            echo -e "${GREEN}✓ 容器正在运行${NC}"
            RUNNING=true
            show_access_url
        else
            echo -e "${YELLOW}✗ 容器未运行${NC}"
            RUNNING=false
        fi
    fi
}

# 显示访问URL
show_access_url() {
    if [ -f "$INSTALL_DIR/.env" ]; then
        PORT=$(grep "PORT=" "$INSTALL_DIR/.env" | cut -d'=' -f2)
        if [ -z "$PORT" ]; then
            PORT=3000
        fi
        
        # 检查是否为本地访问
        if grep -q "127.0.0.1" "$INSTALL_DIR/docker-compose.yml"; then
            echo -e "${BLUE}访问地址: http://127.0.0.1:$PORT${NC}"
        else
            LOCAL_IP=$(hostname -I | awk '{print $1}')
            echo -e "${BLUE}访问地址: http://$LOCAL_IP:$PORT${NC}"
        fi
    fi
}

# 获取外部IP
get_external_ip() {
    external_ip=$(curl -s https://ipv4.icanhazip.com/ || curl -s https://api.ipify.org)
    if [ -z "$external_ip" ]; then
        external_ip=$(hostname -I | awk '{print $1}')
    fi
    echo "$external_ip"
}

# 安装依赖
install_dependencies() {
    echo -e "${YELLOW}正在安装依赖...${NC}"
    
    # 更新包列表
    if command -v apt-get &> /dev/null; then
        apt-get update
        apt-get install -y curl wget git
    elif command -v yum &> /dev/null; then
        yum install -y curl wget git
    elif command -v dnf &> /dev/null; then
        dnf install -y curl wget git
    else
        echo -e "${RED}错误：无法识别的包管理器${NC}"
        exit 1
    fi
}

# 检查Docker Compose命令
check_docker_compose() {
    if docker compose version &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker compose"
    elif command -v docker-compose &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker-compose"
    else
        return 1
    fi
    return 0
}

# 安装Docker
install_docker() {
    echo -e "${YELLOW}正在检查Docker安装状态...${NC}"
    
    if ! command -v docker &> /dev/null; then
        echo -e "${YELLOW}Docker未安装，正在安装...${NC}"
        curl -fsSL https://get.docker.com -o get-docker.sh
        sh get-docker.sh
        systemctl start docker
        systemctl enable docker
        rm get-docker.sh
        echo -e "${GREEN}Docker安装完成${NC}"
    else
        echo -e "${GREEN}Docker已安装${NC}"
    fi
    
    # 检查Docker Compose
    if ! check_docker_compose; then
        echo -e "${YELLOW}Docker Compose未安装，正在安装...${NC}"
        
        # 尝试安装Docker Compose插件
        if command -v apt-get &> /dev/null; then
            apt-get update
            apt-get install -y docker-compose-plugin
        elif command -v yum &> /dev/null; then
            yum install -y docker-compose-plugin
        elif command -v dnf &> /dev/null; then
            dnf install -y docker-compose-plugin
        fi
        
        # 如果插件安装失败，则安装独立版本
        if ! check_docker_compose; then
            echo -e "${YELLOW}正在安装独立版本的Docker Compose...${NC}"
            curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
            chmod +x /usr/local/bin/docker-compose
        fi
        
        echo -e "${GREEN}Docker Compose安装完成${NC}"
    else
        echo -e "${GREEN}Docker Compose已安装${NC}"
    fi
}

# 创建.env文件
create_env_file() {
    echo -e "${YELLOW}正在创建配置文件...${NC}"
    
    echo -n "请输入管理密码: "
    read ADMIN_PASSWORD
    echo ""
    
    cat > "$INSTALL_DIR/.env" << EOF
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
    
    echo -e "使用默认端口3000? (y/n) [默认: y]: "
    read -r use_default_port
    use_default_port=${use_default_port:-y}
    
    if [ "$use_default_port" = "n" ] || [ "$use_default_port" = "N" ]; then
        echo -n "请输入自定义端口: "
        read -r custom_port
        echo "PORT=$custom_port" >> "$INSTALL_DIR/.env"
        PORT=$custom_port
    else
        PORT=3000
    fi
}

# 创建docker-compose.yml文件
create_docker_compose() {
    echo -e "${YELLOW}正在创建Docker Compose文件...${NC}"
    
    echo -e "允许外部访问? (y/n) [默认: y]: "
    read -r allow_external
    allow_external=${allow_external:-y}
    
    if [ "$allow_external" = "n" ] || [ "$allow_external" = "N" ]; then
        PORTS_MAPPING="127.0.0.1:$PORT:$PORT"
    else
        PORTS_MAPPING="$PORT:$PORT"
    fi
    
    cat > "$INSTALL_DIR/docker-compose.yml" << EOF
version: '3.8'
services:
  app:
    image: dreamhartley705/jimihub:latest
    container_name: jimihub
    ports:
      - "$PORTS_MAPPING"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
EOF
}

# 安装JimiHub
install_gemini_proxy_panel() {
    echo -e "${YELLOW}开始安装JimiHub...${NC}"
    
    # 安装依赖
    install_dependencies
    
    # 安装Docker
    install_docker
    
    # 检查Docker Compose命令
    if ! check_docker_compose; then
        echo -e "${RED}错误：Docker Compose未正确安装${NC}"
        return 1
    fi
    
    # 创建安装目录
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    
    # 创建.env文件
    create_env_file
    
    # 创建docker-compose.yml文件
    create_docker_compose
    
    # 启动容器
    echo -e "${YELLOW}正在启动容器...${NC}"
    $DOCKER_COMPOSE_CMD up -d
    
    # 等待容器启动
    sleep 5
    
    if docker ps | grep -q "jimihub"; then
        echo -e "${GREEN}✓ 安装完成！${NC}"
        echo ""
        
        # 显示访问地址
        if [ "$allow_external" = "n" ] || [ "$allow_external" = "N" ]; then
            echo -e "${BLUE}本地访问地址: http://127.0.0.1:$PORT${NC}"
        else
            external_ip=$(get_external_ip)
            echo -e "${BLUE}访问地址: http://$external_ip:$PORT${NC}"
        fi
        

    else
        echo -e "${RED}✗ 安装失败，请检查错误信息${NC}"
        echo -e "${YELLOW}容器日志:${NC}"
        $DOCKER_COMPOSE_CMD logs
    fi
}

# 启动容器
start_container() {
    if [ "$INSTALLED" = true ]; then
        echo -e "${YELLOW}正在启动容器...${NC}"
        cd "$INSTALL_DIR"
        if check_docker_compose; then
            $DOCKER_COMPOSE_CMD up -d
            sleep 3
            if docker ps | grep -q "jimihub"; then
                echo -e "${GREEN}✓ 容器启动成功${NC}"
            else
                echo -e "${RED}✗ 容器启动失败${NC}"
            fi
        else
            echo -e "${RED}Docker Compose未找到${NC}"
        fi
    else
        echo -e "${RED}请先安装JimiHub${NC}"
    fi
}

# 停止容器
stop_container() {
    if [ "$INSTALLED" = true ]; then
        echo -e "${YELLOW}正在停止容器...${NC}"
        cd "$INSTALL_DIR"
        if check_docker_compose; then
            $DOCKER_COMPOSE_CMD down
            echo -e "${GREEN}✓ 容器已停止${NC}"
        else
            echo -e "${RED}Docker Compose未找到${NC}"
        fi
    else
        echo -e "${RED}请先安装JimiHub${NC}"
    fi
}

# 重启容器
restart_container() {
    if [ "$INSTALLED" = true ]; then
        echo -e "${YELLOW}正在重启容器...${NC}"
        cd "$INSTALL_DIR"
        if check_docker_compose; then
            $DOCKER_COMPOSE_CMD restart
            sleep 3
            if docker ps | grep -q "jimihub"; then
                echo -e "${GREEN}✓ 容器重启成功${NC}"
            else
                echo -e "${RED}✗ 容器重启失败${NC}"
            fi
        else
            echo -e "${RED}Docker Compose未找到${NC}"
        fi
    else
        echo -e "${RED}请先安装JimiHub${NC}"
    fi
}

# 更新JimiHub
update_jimihub() {
    if [ "$INSTALLED" = false ]; then
        echo -e "${RED}JimiHub未安装，无法更新${NC}"
        return
    fi

    echo -e "${YELLOW}开始更新JimiHub...${NC}"
    cd "$INSTALL_DIR"
    if ! check_docker_compose; then
        echo -e "${RED}Docker Compose未找到${NC}"
        return
    fi

    echo "正在拉取最新的Docker镜像..."
    if ! docker pull dreamhartley705/jimihub:latest; then
        echo -e "${RED}✗ 拉取最新镜像失败，请检查网络或镜像名称。${NC}"
        return
    fi

    echo "正在停止并使用新镜像重新创建容器..."
    $DOCKER_COMPOSE_CMD up -d --force-recreate

    sleep 5
    if docker ps | grep -q "jimihub"; then
        echo -e "${GREEN}✓ 更新完成！${NC}"
    else
        echo -e "${RED}✗ 更新失败，请检查错误信息${NC}"
        echo -e "${YELLOW}容器日志:${NC}"
        $DOCKER_COMPOSE_CMD logs
    fi
}

# 卸载JimiHub
uninstall_jimihub() {
    if [ "$INSTALLED" = false ]; then
        echo -e "${RED}JimiHub未安装，无需卸载${NC}"
        return
    fi

    echo -e "${YELLOW}警告：这将停止并删除JimiHub容器。${NC}"
    echo -n "是否保留数据库文件? (y/n) [默认: y]: "
    read -r keep_data
    keep_data=${keep_data:-y}

    echo -e "${YELLOW}开始卸载JimiHub...${NC}"
    
    if [ -d "$INSTALL_DIR" ]; then
        cd "$INSTALL_DIR"
        if check_docker_compose; then
            echo "正在停止并删除JimiHub容器..."
            $DOCKER_COMPOSE_CMD down
        fi
        cd ..
    fi

    if [[ "$keep_data" == "n" || "$keep_data" == "N" ]]; then
        echo "正在删除安装目录（包括数据）..."
        rm -rf "$INSTALL_DIR"
        echo -e "${GREEN}✓ JimiHub及其数据已完全删除。${NC}"
    else
        echo -e "${GREEN}✓ JimiHub容器已停止。本地文件（包括数据）已保留在 $INSTALL_DIR ${NC}"
    fi

    echo -n "是否要卸载Docker? (y/n) [默认: n]: "
    read -r uninstall_docker
    uninstall_docker=${uninstall_docker:-n}

    if [[ "$uninstall_docker" == "y" || "$uninstall_docker" == "Y" ]]; then
        # 检查是否还有其他Docker容器
        if [ -n "$(docker ps -aq)" ]; then
            echo -e "${YELLOW}警告：检测到系统上存在其他Docker容器。为避免影响其他应用，Docker未被卸载。${NC}"
        else
            echo "正在卸载Docker..."
            if command -v apt-get &> /dev/null; then
                apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
                apt-get autoremove -y --purge
                rm -rf /var/lib/docker /etc/docker
            elif command -v yum &> /dev/null; then
                yum remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
                rm -rf /var/lib/docker /var/lib/containerd
            elif command -v dnf &> /dev/null; then
                dnf remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
                rm -rf /var/lib/docker /var/lib/containerd
            fi
            echo -e "${GREEN}✓ Docker卸载完成。${NC}"
        fi
    fi

    unregister_command
    echo -e "${GREEN}✓ JimiHub卸载完成！感谢使用！${NC}"
    exit 0
}

# 注册系统命令
register_command() {
    if [ ! -f "$SCRIPT_PATH" ]; then
        cp "$0" "$SCRIPT_PATH"
        chmod +x "$SCRIPT_PATH"
        echo -e "${GREEN}✓ 已注册系统命令 'jimihub'${NC}"
    fi
}

# 注销系统命令
unregister_command() {
    if [ -f "$SCRIPT_PATH" ]; then
        rm -f "$SCRIPT_PATH"
        echo -e "${GREEN}✓ 已注销系统命令 'jimihub'${NC}"
    fi
}


# 显示菜单
show_menu() {
    echo ""
    echo -e "${YELLOW}请选择操作:${NC}"
    echo "1. 安装 JimiHub"
    echo "2. 启动 JimiHub 容器"
    echo "3. 停止 JimiHub 容器"
    echo "4. 重启 JimiHub 容器"
    echo "5. 更新 JimiHub"
    echo "6. 卸载 JimiHub"
    echo "0. 退出"
    echo ""
    echo -n "请输入选项 [0-6]: "
}

# 主函数
main() {
    check_root
    
    # 如果是卸载命令，直接执行
    if [[ "$1" == "uninstall" ]]; then
        check_install_status
        uninstall_jimihub
        exit 0
    fi

    register_command
    
    while true; do
        show_welcome
        check_install_status
        check_container_status
        show_menu
        
        read -r choice
        case $choice in
            1)
                install_gemini_proxy_panel
                echo ""
                echo -n "按回车键继续..."
                read -r
                ;;
            2)
                start_container
                echo ""
                echo -n "按回车键继续..."
                read -r
                ;;
            3)
                stop_container
                echo ""
                echo -n "按回车键继续..."
                read -r
                ;;
            4)
                restart_container
                echo ""
                echo -n "按回车键继续..."
                read -r
                ;;
            5)
                update_jimihub
                echo ""
                echo -n "按回车键继续..."
                read -r
                ;;
            6)
                uninstall_jimihub
                ;;
            0)
                echo -e "${GREEN}感谢使用！${NC}"
                echo -e "${BLUE}提示：下次可以直接使用 'jimihub' 命令进入管理脚本${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}无效选项，请重新选择${NC}"
                sleep 2
                ;;
        esac
    done
}

# 运行主函数
main "$@"