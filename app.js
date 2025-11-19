// UI Controller for ARM64 Simulator

class SimulatorUI {
    constructor() {
        this.simulator = new ARM64Simulator();
        this.runInterval = null;
        this.initializeElements();
        this.attachEventListeners();
        this.updateDisplay();
    }

    initializeElements() {
        this.assemblyInput = document.getElementById('assemblyInput');
        this.loadBtn = document.getElementById('loadBtn');
        this.stepBtn = document.getElementById('stepBtn');
        this.runBtn = document.getElementById('runBtn');
        this.pauseBtn = document.getElementById('pauseBtn');
        this.resetBtn = document.getElementById('resetBtn');
        this.statusText = document.getElementById('statusText');
        this.currentInstruction = document.getElementById('currentInstruction');
        this.registersDisplay = document.getElementById('registersDisplay');
        this.memoryVisualization = document.getElementById('memoryVisualization');
    }

    attachEventListeners() {
        this.loadBtn.addEventListener('click', () => this.loadProgram());
        this.stepBtn.addEventListener('click', () => this.step());
        this.runBtn.addEventListener('click', () => this.startRunning());
        this.pauseBtn.addEventListener('click', () => this.pause());
        this.resetBtn.addEventListener('click', () => this.reset());
    }

    loadProgram() {
        const code = this.assemblyInput.value;
        if (!code.trim()) {
            alert('Please enter some assembly code');
            return;
        }

        try {
            this.simulator.loadProgram(code);
            this.updateDisplay();
            this.updateStatus('Program loaded');
            this.highlightCurrentInstruction();
        } catch (error) {
            console.error('Error loading program:', error);
            alert(`Error loading program: ${error.message}`);
            this.updateStatus(`Error: ${error.message}`);
            // Still try to update display in case partial data was loaded
            try {
                this.updateDisplay();
            } catch (e) {
                console.error('Error updating display:', e);
            }
        }
    }

    step() {
        if (this.simulator.instructions.length === 0) {
            this.updateStatus('No program loaded');
            return;
        }

        if (this.simulator.currentInstructionIndex >= this.simulator.instructions.length) {
            this.updateStatus('Program finished');
            return;
        }

        try {
            const success = this.simulator.step();
            if (success) {
                this.updateDisplay();
                this.highlightCurrentInstruction();
                this.updateStatus('Stepped');
            } else {
                this.updateStatus('Program finished');
            }
        } catch (error) {
            this.updateStatus(`Error: ${error.message}`);
            alert(`Execution error: ${error.message}`);
        }
    }

    startRunning() {
        if (this.simulator.instructions.length === 0) {
            this.updateStatus('No program loaded');
            return;
        }

        if (this.simulator.currentInstructionIndex >= this.simulator.instructions.length) {
            this.updateStatus('Program finished');
            return;
        }

        this.simulator.isRunning = true;
        this.simulator.isPaused = false;
        this.runBtn.disabled = true;
        this.pauseBtn.disabled = false;
        this.stepBtn.disabled = true;

        this.runInterval = setInterval(() => {
            if (this.simulator.isPaused) {
                return;
            }

            try {
                const success = this.simulator.step();
                this.updateDisplay();
                this.highlightCurrentInstruction();

                if (!success || this.simulator.currentInstructionIndex >= this.simulator.instructions.length) {
                    this.pause();
                    this.updateStatus('Program finished');
                }
            } catch (error) {
                this.pause();
                this.updateStatus(`Error: ${error.message}`);
                alert(`Execution error: ${error.message}`);
            }
        }, 500); // 500ms delay between steps
    }

    pause() {
        this.simulator.isRunning = false;
        this.simulator.isPaused = true;
        if (this.runInterval) {
            clearInterval(this.runInterval);
            this.runInterval = null;
        }
        this.runBtn.disabled = false;
        this.pauseBtn.disabled = true;
        this.stepBtn.disabled = false;
        this.updateStatus('Paused');
    }

    reset() {
        if (this.runInterval) {
            clearInterval(this.runInterval);
            this.runInterval = null;
        }

        this.simulator.reset();
        this.updateDisplay();
        this.highlightCurrentInstruction();
        this.updateStatus('Reset');
        this.runBtn.disabled = false;
        this.pauseBtn.disabled = true;
        this.stepBtn.disabled = false;
    }

    updateStatus(message) {
        this.statusText.textContent = message;
    }

    highlightCurrentInstruction() {
        const currentIndex = this.simulator.currentInstructionIndex;
        
        // Update current instruction display
        if (currentIndex < this.simulator.instructions.length) {
            const instruction = this.simulator.instructions[currentIndex];
            this.currentInstruction.textContent = `PC: ${currentIndex} | ${instruction.original}`;
            
            // Scroll to current instruction in textarea
            const lines = this.assemblyInput.value.split('\n');
            let charIndex = 0;
            for (let i = 0; i < currentIndex && i < lines.length; i++) {
                charIndex += lines[i].length + 1; // +1 for newline
            }
            this.assemblyInput.setSelectionRange(charIndex, charIndex);
            this.assemblyInput.scrollTop = this.assemblyInput.scrollHeight * (currentIndex / Math.max(lines.length, 1));
        } else {
            this.currentInstruction.textContent = 'Program finished';
        }
    }

    updateDisplay() {
        this.updateRegisters();
        this.updateMemory();
    }

    updateRegisters() {
        this.registersDisplay.innerHTML = '';

        // Show Xn/Wn in single card for each register (0-30)
        for (let i = 0; i <= 30; i++) {
            const xRegName = `x${i}`;
            const xValue = this.simulator.registers[xRegName] || 0n;
            const wValue = xValue & 0xFFFFFFFFn;
            const decimalValue = Number(xValue);
            
            const isChanged = this.simulator.changedRegisters.has(xRegName) || 
                            this.simulator.changedRegisters.has(`w${i}`);

            // Single card for Xn/Wn
            const registerItem = document.createElement('div');
            registerItem.className = `register-item ${isChanged ? 'changed' : ''}`;
            
            // Header: Xn / Wn
            const registerName = document.createElement('div');
            registerName.className = 'register-name';
            registerName.textContent = `X${i} / W${i}`;
            
            // X value (64-bit hex)
            const xRegisterValue = document.createElement('div');
            xRegisterValue.className = 'register-value';
            xRegisterValue.textContent = `0x${xValue.toString(16).toUpperCase().padStart(16, '0')}`;
            
            registerItem.appendChild(registerName);
            registerItem.appendChild(xRegisterValue);
            this.registersDisplay.appendChild(registerItem);

            // Remove highlight after animation
            if (isChanged) {
                setTimeout(() => {
                    registerItem.classList.remove('changed');
                }, 600);
            }
        }

        // Special registers (sp, lr, pc)
        const specialRegs = ['sp', 'lr', 'pc'];
        specialRegs.forEach(regName => {
            const value = this.simulator.registers[regName] || 0n;
            const decimalValue = Number(value);
            const isChanged = this.simulator.changedRegisters.has(regName);

            const registerItem = document.createElement('div');
            registerItem.className = `register-item ${isChanged ? 'changed' : ''}`;
            
            const registerName = document.createElement('div');
            registerName.className = 'register-name';
            registerName.textContent = regName.toUpperCase();
            
            const registerValue = document.createElement('div');
            registerValue.className = 'register-value';
            registerValue.textContent = `0x${value.toString(16).toUpperCase().padStart(16, '0')}`;
            
            registerItem.appendChild(registerName);
            registerItem.appendChild(registerValue);
            this.registersDisplay.appendChild(registerItem);

            // Remove highlight after animation
            if (isChanged) {
                setTimeout(() => {
                    registerItem.classList.remove('changed');
                }, 600);
            }
        });
    }

    updateMemory() {
        this.memoryVisualization.innerHTML = '';
        
        let regions;
        try {
            regions = this.simulator.getAllMemoryRegions();
        } catch (error) {
            console.error('Error getting memory regions:', error);
            this.updateStatus(`Error getting memory regions: ${error.message}`);
            // Return empty regions object so UI doesn't break
            regions = {};
        }
        
        // Order: Stack, Heap, BSS, Data, Rodata (left to right)
        const regionOrder = ['stack', 'heap', 'bss', 'data', 'rodata'];
        
        // Render horizontal memory map overview
        this.renderMemoryMapOverview(regions, regionOrder);
        
        // Render stack frame visualization below the memory map (integrated, not separate)
        if (regions.stack) {
            const stackDetailsContainer = document.createElement('div');
            stackDetailsContainer.className = 'stack-details-integrated';
            const stackContent = document.createElement('div');
            stackContent.className = 'stack-details-content';
            this.renderStackRegion(stackContent, regions.stack);
            stackDetailsContainer.appendChild(stackContent);
            this.memoryVisualization.appendChild(stackDetailsContainer);
        }
    }

    renderMemoryMapOverview(regions, regionOrder) {
        const overviewDiv = document.createElement('div');
        overviewDiv.className = 'memory-map-overview';
        
        const header = document.createElement('div');
        header.className = 'memory-map-header';
        header.textContent = 'Memory Map';
        overviewDiv.appendChild(header);
        
        const mapContainer = document.createElement('div');
        mapContainer.className = 'memory-map-container';
        
        // All regions get equal width (same width, only heights vary)
        const equalWidthPercent = 100 / regionOrder.length;
        
        regionOrder.forEach(regionKey => {
            const region = regions[regionKey];
            if (!region) {
                console.warn(`Region ${regionKey} not found in regions object`);
                return;
            }
            
            const regionRect = document.createElement('div');
            regionRect.className = `memory-region-rect ${regionKey}`;
            regionRect.style.width = `${equalWidthPercent}%`; // Equal width for all
            regionRect.style.flexShrink = 0; // Prevent wrapping
            
            const regionName = document.createElement('div');
            regionName.className = 'region-rect-name';
            regionName.textContent = region.name;
            
            const regionRange = document.createElement('div');
            regionRange.className = 'region-rect-range';
            regionRange.textContent = `0x${region.start.toString(16).toUpperCase()} — 0x${region.end.toString(16).toUpperCase()}`;
            
            const regionInfo = document.createElement('div');
            regionInfo.className = 'region-rect-info';
            if (!region.isEmpty && region.data.length > 0) {
                // Show all elements in format "address:value", one per line
                const elements = region.data.map(entry => {
                    const addrStr = `0x${entry.address.toString(16).toUpperCase()}`;
                    // Format value based on size
                    let valueStr;
                    if (entry.size === 1) {
                        valueStr = `0x${entry.value.toString(16).toUpperCase().padStart(2, '0')}`;
                    } else if (entry.size === 2) {
                        valueStr = `0x${entry.value.toString(16).toUpperCase().padStart(4, '0')}`;
                    } else if (entry.size === 4) {
                        valueStr = `0x${entry.value.toString(16).toUpperCase().padStart(8, '0')}`;
                    } else {
                        valueStr = `0x${entry.value.toString(16).toUpperCase().padStart(16, '0')}`;
                    }
                    return `${addrStr}:${valueStr}`;
                });
                regionInfo.innerHTML = elements.join('<br>');
                regionInfo.style.fontSize = '9px';
                regionInfo.style.overflowY = 'auto';
                regionInfo.style.maxHeight = '100px';
                regionInfo.style.textAlign = 'left';
                regionInfo.style.padding = '4px';
            } else {
                regionInfo.textContent = 'empty';
            }
            
            regionRect.appendChild(regionName);
            regionRect.appendChild(regionRange);
            regionRect.appendChild(regionInfo);
            
            // Add click handler to show details
            regionRect.addEventListener('click', () => {
                this.showRegionDetails(regionKey, region);
            });
            
            mapContainer.appendChild(regionRect);
        });
        
        overviewDiv.appendChild(mapContainer);
        this.memoryVisualization.appendChild(overviewDiv);
    }

    renderStackDetails(stackRegion) {
        const stackDiv = document.createElement('div');
        stackDiv.className = 'stack-details-section';
        
        const header = document.createElement('div');
        header.className = 'stack-details-header';
        header.textContent = 'Stack Details';
        stackDiv.appendChild(header);
        
        const stackContent = document.createElement('div');
        stackContent.className = 'stack-details-content';
        
        this.renderStackRegion(stackContent, stackRegion);
        
        stackDiv.appendChild(stackContent);
        this.memoryVisualization.appendChild(stackDiv);
    }

    showRegionDetails(regionKey, region) {
        // Create a modal or side panel to show region details
        // For now, just log - can be enhanced later
        console.log(`Region details for ${regionKey}:`, region);
    }

    showRegionDetails(regionKey, region) {
        // Create a modal or expandable section to show region details
        // For now, we'll show it in a side panel or modal
        // This can be enhanced later with a proper modal dialog
        const existingDetails = document.querySelector('.region-details-modal');
        if (existingDetails) {
            existingDetails.remove();
        }
        
        const modal = document.createElement('div');
        modal.className = 'region-details-modal';
        
        const modalContent = document.createElement('div');
        modalContent.className = 'region-details-content';
        
        const header = document.createElement('div');
        header.className = 'region-details-header';
        header.innerHTML = `
            <h3>${region.name} Details</h3>
            <button class="close-details">×</button>
        `;
        header.querySelector('.close-details').addEventListener('click', () => {
            modal.remove();
        });
        modalContent.appendChild(header);
        
        const range = document.createElement('div');
        range.className = 'region-details-range';
        range.textContent = `0x${region.start.toString(16).toUpperCase()} — 0x${region.end.toString(16).toUpperCase()}`;
        modalContent.appendChild(range);
        
        const dataList = document.createElement('div');
        dataList.className = 'region-details-list';
        
        if (region.isEmpty) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-region';
            emptyMsg.textContent = 'No data written';
            dataList.appendChild(emptyMsg);
        } else {
            region.data.forEach(item => {
                const memoryItem = document.createElement('div');
                const isChanged = this.simulator.changedMemory.has(item.address) || 
                               this.simulator.changedMemory.has(item.address + 1) ||
                               this.simulator.changedMemory.has(item.address + 2) ||
                               this.simulator.changedMemory.has(item.address + 3) ||
                               this.simulator.changedMemory.has(item.address + 4) ||
                               this.simulator.changedMemory.has(item.address + 5) ||
                               this.simulator.changedMemory.has(item.address + 6) ||
                               this.simulator.changedMemory.has(item.address + 7);
                
                memoryItem.className = `memory-item ${isChanged ? 'changed' : ''}`;
                
                const address = document.createElement('span');
                address.className = 'memory-address';
                address.textContent = `[0x${item.address.toString(16).toUpperCase().padStart(8, '0')}]`;
                
                const valueSpan = document.createElement('span');
                valueSpan.className = 'memory-value';
                valueSpan.textContent = `0x${item.value.toString(16).toUpperCase().padStart(16, '0')}`;
                
                memoryItem.appendChild(address);
                memoryItem.appendChild(valueSpan);
                dataList.appendChild(memoryItem);
                
                if (isChanged) {
                    setTimeout(() => {
                        memoryItem.classList.remove('changed');
                    }, 600);
                }
            });
        }
        
        modalContent.appendChild(dataList);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
    }

    renderStackRegion(container, region) {
        const currentSP = Number(this.simulator.registers.sp);
        const initialSP = Number(this.simulator.memoryLayout.stack.end);
        
        // SP indicator
        const spIndicator = document.createElement('div');
        spIndicator.className = 'sp-indicator';
        spIndicator.textContent = `SP → 0x${currentSP.toString(16).toUpperCase()}`;
        container.appendChild(spIndicator);

        // Get stack frames
        const frames = this.simulator.getStackFramesForDisplay();
        
        if (frames.length === 0 && currentSP >= initialSP) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-stack';
            emptyMsg.textContent = '[Empty Stack]';
            container.appendChild(emptyMsg);
            return;
        }

        // Constants for frame rendering
        const pixelsPerByte = 4;
        const frameSpacing = 8;
        const headerHeight = 50;
        
        // Get all memory writes and assign them to frames
        const allMemoryWrites = this.getAllMemoryWritesInStack();
        
        // Display frames as vertical column
        frames.forEach((frame, frameIndex) => {
            const frameHeight = frame.size * pixelsPerByte;
            const totalFrameHeight = headerHeight + frameHeight;
            
            const frameDiv = document.createElement('div');
            frameDiv.className = `stack-frame ${frame.isActive ? 'active' : ''}`;
            frameDiv.style.position = 'relative';
            frameDiv.style.height = `${totalFrameHeight}px`;
            frameDiv.style.minHeight = `${totalFrameHeight}px`;
            frameDiv.style.width = '85%';
            frameDiv.style.maxWidth = '500px';
            frameDiv.style.marginBottom = `${frameSpacing}px`;
            frameDiv.style.overflow = 'hidden';
            
            // Frame header
            const header = document.createElement('div');
            header.className = 'stack-frame-header';
            header.style.position = 'absolute';
            header.style.top = '0';
            header.style.left = '0';
            header.style.right = '0';
            header.style.height = `${headerHeight}px`;
            header.style.display = 'flex';
            header.style.flexDirection = 'column';
            header.style.justifyContent = 'center';
            header.style.padding = '8px 12px';
            header.innerHTML = `
                <strong>Frame #${frame.id}</strong> (${frame.size} bytes)<br>
                <small>SP: 0x${frame.sp.toString(16).toUpperCase()}</small>
            `;
            frameDiv.appendChild(header);
            
            // Content area
            const contentArea = document.createElement('div');
            contentArea.style.position = 'absolute';
            contentArea.style.top = `${headerHeight}px`;
            contentArea.style.left = '0';
            contentArea.style.right = '0';
            contentArea.style.height = `${frameHeight}px`;
            contentArea.style.overflow = 'hidden';
            frameDiv.appendChild(contentArea);
            
            // Find memory items for this frame
            const frameMemoryItems = allMemoryWrites.filter(item => {
                const addr = item.address;
                return addr >= frame.sp && addr < frame.sp + frame.size;
            });
            
            // Group by 8-byte aligned addresses
            const memoryGroups = new Map();
            frameMemoryItems.forEach(item => {
                const alignedAddr = Math.floor(item.address / 8) * 8;
                if (!memoryGroups.has(alignedAddr)) {
                    memoryGroups.set(alignedAddr, {
                        address: alignedAddr,
                        value: this.simulator.getMemoryAtAddress(alignedAddr),
                        size: 8
                    });
                }
            });
            
            // Render memory items
            Array.from(memoryGroups.values()).forEach(memItem => {
                const offsetInFrame = memItem.address - frame.sp;
                const yPercent = (offsetInFrame / frame.size) * 100;
                const heightPercent = (memItem.size / frame.size) * 100;
                
                const memoryItem = document.createElement('div');
                const isChanged = this.simulator.changedMemory.has(memItem.address) || 
                               this.simulator.changedMemory.has(memItem.address + 1) ||
                               this.simulator.changedMemory.has(memItem.address + 2) ||
                               this.simulator.changedMemory.has(memItem.address + 3) ||
                               this.simulator.changedMemory.has(memItem.address + 4) ||
                               this.simulator.changedMemory.has(memItem.address + 5) ||
                               this.simulator.changedMemory.has(memItem.address + 6) ||
                               this.simulator.changedMemory.has(memItem.address + 7);
                
                memoryItem.className = `stack-memory-item ${isChanged ? 'changed' : ''}`;
                memoryItem.style.position = 'absolute';
                memoryItem.style.top = `${yPercent}%`;
                memoryItem.style.height = `${heightPercent}%`;
                memoryItem.style.left = '0';
                memoryItem.style.right = '0';
                memoryItem.style.display = 'flex';
                memoryItem.style.alignItems = 'center';
                memoryItem.style.justifyContent = 'space-between';
                memoryItem.style.padding = '4px 8px';
                memoryItem.style.boxSizing = 'border-box';
                
                const address = document.createElement('span');
                address.className = 'memory-address';
                address.textContent = `[0x${memItem.address.toString(16).toUpperCase().padStart(8, '0')}]`;
                
                const valueSpan = document.createElement('span');
                valueSpan.className = 'memory-value';
                valueSpan.textContent = `0x${memItem.value.toString(16).toUpperCase().padStart(16, '0')}`;
                
                memoryItem.appendChild(address);
                memoryItem.appendChild(valueSpan);
                contentArea.appendChild(memoryItem);
                
                if (isChanged) {
                    setTimeout(() => {
                        memoryItem.classList.remove('changed');
                    }, 600);
                }
            });
            
            container.appendChild(frameDiv);
        });
    }

    getAllMemoryWritesInStack() {
        // Get all memory addresses that have been written to in the stack region
        const stackRegion = this.simulator.memoryLayout.stack;
        const initialSP = Number(stackRegion.end);
        const currentSP = Number(this.simulator.registers.sp);
        const stackStart = Math.min(currentSP, initialSP);
        const stackEnd = initialSP;
        
        const memoryWrites = [];
        const allAddresses = Array.from(this.simulator.memory.keys());
        
        // Group addresses into 8-byte aligned entries
        const entryMap = new Map();
        allAddresses.forEach(addr => {
            if (addr >= stackStart && addr < stackEnd) {
                const alignedAddr = Math.floor(addr / 8) * 8;
                if (!entryMap.has(alignedAddr)) {
                    entryMap.set(alignedAddr, alignedAddr);
                }
            }
        });
        
        entryMap.forEach(addr => {
            memoryWrites.push({
                address: addr,
                value: this.simulator.getMemoryAtAddress(addr)
            });
        });
        
        return memoryWrites.sort((a, b) => b.address - a.address); // Sort descending (stack grows downward)
    }
}

// Initialize the UI when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.simulatorUI = new SimulatorUI();
});

