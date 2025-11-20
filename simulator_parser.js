// ARM64 Parser - Handles sections, directives, labels, and two-pass parsing

class ARM64Parser {
    constructor(simulator) {
        this.simulator = simulator;
    }

    // First pass: build symbol table
    buildSymbolTable(lines) {
        const symbolTable = new Map();
        const globalSymbols = new Set(); // Track .global symbols
        let currentSection = 'text';
        const sectionCounters = {
            rodata: this.simulator.memoryLayout.rodata.start,
            data: this.simulator.memoryLayout.data.start,
            bss: this.simulator.memoryLayout.bss.start,
            text: 0x00000000n
        };

        for (const line of lines) {
            const trimmed = this.removeComments(line).trim();
            if (!trimmed) continue;

            // Check for section directive
            const sectionMatch = trimmed.match(/^\.(text|rodata|data|bss)\s*$/i);
            if (sectionMatch) {
                currentSection = sectionMatch[1].toLowerCase();
                continue;
            }

            // Check for .global directive
            const globalMatch = trimmed.match(/^\.global\s+(.+)$/i);
            if (globalMatch) {
                const symbols = globalMatch[1].split(',').map(s => s.trim());
                for (const sym of symbols) {
                    globalSymbols.add(sym);
                }
                continue;
            }

            // Check for label (may be on same line as directive, e.g., "label: .quad 10")
            let labelMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
            let labelName = null;
            let lineAfterLabel = trimmed;
            
            if (labelMatch) {
                labelName = labelMatch[1];
                lineAfterLabel = labelMatch[2].trim();
                
                // Set label address to current counter
                // The label points to where the next item (instruction or data) will be placed
                const address = sectionCounters[currentSection];
                
                if (symbolTable.has(labelName)) {
                    throw new Error(`Duplicate label: ${labelName}`);
                }
                
                symbolTable.set(labelName, {
                    address: address,
                    section: currentSection,
                    type: currentSection === 'text' ? 'code' : 'data',
                    isGlobal: globalSymbols.has(labelName)
                });
                
                // If there's nothing after the label, continue to next line
                // The counter will be advanced when we process the next line
                if (!lineAfterLabel) {
                    continue;
                }
            }

            // Advance location counter based on directive or instruction
            if (currentSection === 'text') {
                // Instructions are 4 bytes
                sectionCounters.text += 4n;
            } else {
                // Handle data directives (use lineAfterLabel if label was on same line)
                const directiveMatch = lineAfterLabel.match(/^\.(quad|word|hword|byte|skip|align|asciz|string)\s*(.*)$/i);
                if (directiveMatch) {
                    const directive = directiveMatch[1].toLowerCase();
                    const rest = directiveMatch[2].trim();
                    
                    // Handle alignment FIRST (before placing data)
                    if (directive === 'align') {
                        const alignPower = parseInt(rest) || 3; // Default: align to 2^3 = 8 bytes
                        const alignBytes = BigInt(1) << BigInt(alignPower); // 2^alignPower
                        const mask = alignBytes - 1n;
                        sectionCounters[currentSection] = (sectionCounters[currentSection] + mask) & ~mask;
                    } else if (directive === 'asciz' || directive === 'string') {
                        // .asciz "string" - null-terminated string
                        // Parse the string and process escape sequences to get accurate length
                        const stringMatch = rest.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/);
                        if (stringMatch) {
                            const rawStr = stringMatch[1] || stringMatch[2] || '';
                            // Process escape sequences to get actual string length
                            let processedLength = 0;
                            for (let i = 0; i < rawStr.length; i++) {
                                if (rawStr[i] === '\\' && i + 1 < rawStr.length) {
                                    i++; // Skip escape character
                                    processedLength++; // Each escape sequence becomes one character
                                } else {
                                    processedLength++;
                                }
                            }
                            // Count bytes: processed string length + 1 for null terminator
                            sectionCounters[currentSection] += BigInt(processedLength + 1);
                        }
                    } else if (directive === 'quad') {
                        const values = rest.split(',').filter(v => v.trim());
                        sectionCounters[currentSection] += BigInt(values.length) * 8n;
                    } else if (directive === 'word') {
                        const values = rest.split(',').filter(v => v.trim());
                        sectionCounters[currentSection] += BigInt(values.length) * 4n;
                    } else if (directive === 'hword') {
                        const values = rest.split(',').filter(v => v.trim());
                        sectionCounters[currentSection] += BigInt(values.length) * 2n;
                    } else if (directive === 'byte') {
                        const values = rest.split(',').filter(v => v.trim());
                        sectionCounters[currentSection] += BigInt(values.length);
                    } else if (directive === 'skip') {
                        const size = parseInt(rest);
                        if (!isNaN(size) && size > 0) {
                            sectionCounters[currentSection] += BigInt(size);
                        }
                    }
                } else if (!trimmed.startsWith('.')) {
                    // Regular instruction in text section
                    sectionCounters.text += 4n;
                }
            }
        }

        return { symbolTable, sectionCounters };
    }

    // Second pass: parse instructions and directives, resolve labels
    parseProgram(lines, symbolTable) {
        const instructions = [];
        const dataInitializations = [];
        let currentSection = 'text';
        const sectionCounters = {
            rodata: this.simulator.memoryLayout.rodata.start,
            data: this.simulator.memoryLayout.data.start,
            bss: this.simulator.memoryLayout.bss.start,
            text: 0x00000000n
        };

        for (const line of lines) {
            const trimmed = this.removeComments(line).trim();
            if (!trimmed) continue;

            // Section directive
            const sectionMatch = trimmed.match(/^\.(text|rodata|data|bss)\s*$/i);
            if (sectionMatch) {
                currentSection = sectionMatch[1].toLowerCase();
                continue;
            }

            // Check for label on same line (e.g., "label: .quad 10")
            let labelMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
            let labelName = null;
            let lineAfterLabel = trimmed;
            
            if (labelMatch) {
                labelName = labelMatch[1];
                lineAfterLabel = labelMatch[2].trim();
                // Label address is current counter (already set in first pass)
                // Just verify it matches
                if (symbolTable.has(labelName)) {
                    const labelInfo = symbolTable.get(labelName);
                    // Ensure the label's address matches current counter
                    if (labelInfo.address !== sectionCounters[currentSection]) {
                        // This shouldn't happen if first pass was correct, but handle it
                        console.warn(`Label ${labelName} address mismatch: expected ${sectionCounters[currentSection]}, got ${labelInfo.address}`);
                    }
                }
            } else if (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*$/)) {
                // Label on its own line (already in symbol table)
                // The label address should match the current counter (where next instruction will be placed)
                // Don't advance counter yet - it will advance when we process the next instruction
                continue;
            }

            // Directive
            if (lineAfterLabel.startsWith('.')) {
                const directiveMatch = lineAfterLabel.match(/^\.(quad|word|hword|byte|skip|align|global|asciz|string)\s*(.*)$/i);
                if (directiveMatch) {
                    const directive = directiveMatch[1].toLowerCase();
                    const rest = directiveMatch[2].trim();
                    
                    if (directive === 'global') {
                        // Just mark as entry point, no action needed
                        continue;
                    }
                    
                    // Handle alignment FIRST (before placing data)
                    if (directive === 'align') {
                        const alignPower = parseInt(rest) || 3; // Default: align to 2^3 = 8 bytes
                        const alignBytes = BigInt(1) << BigInt(alignPower); // 2^alignPower
                        const mask = alignBytes - 1n;
                        // Align to next boundary: (current + mask) & ~mask
                        sectionCounters[currentSection] = (sectionCounters[currentSection] + mask) & ~mask;
                        continue;
                    }
                    
                    // Handle .asciz and .string directives (null-terminated strings)
                    if (directive === 'asciz' || directive === 'string') {
                        // Parse string literal (handles both "..." and '...')
                        const stringMatch = rest.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/);
                        if (stringMatch) {
                            const rawStr = stringMatch[1] || stringMatch[2] || '';
                            // Process escape sequences
                            let processedStr = '';
                            for (let i = 0; i < rawStr.length; i++) {
                                if (rawStr[i] === '\\' && i + 1 < rawStr.length) {
                                    i++;
                                    switch (rawStr[i]) {
                                        case 'n':
                                            processedStr += '\n';
                                            break;
                                        case 't':
                                            processedStr += '\t';
                                            break;
                                        case '\\':
                                            processedStr += '\\';
                                            break;
                                        case '"':
                                            processedStr += '"';
                                            break;
                                        case '\'':
                                            processedStr += '\'';
                                            break;
                                        case '0':
                                            processedStr += '\0';
                                            break;
                                        default:
                                            processedStr += rawStr[i];
                                    }
                                } else {
                                    processedStr += rawStr[i];
                                }
                            }
                            
                            // Store each byte of the string plus null terminator
                            const startAddr = sectionCounters[currentSection];
                            for (let i = 0; i < processedStr.length; i++) {
                                dataInitializations.push({
                                    address: sectionCounters[currentSection],
                                    value: BigInt(processedStr.charCodeAt(i)),
                                    size: 1,
                                    section: currentSection
                                });
                                sectionCounters[currentSection] += 1n;
                            }
                            // Add null terminator
                            dataInitializations.push({
                                address: sectionCounters[currentSection],
                                value: 0n,
                                size: 1,
                                section: currentSection
                            });
                            sectionCounters[currentSection] += 1n;
                        } else {
                            throw new Error(`Invalid string literal in .asciz/.string directive: ${rest}`);
                        }
                        continue;
                    }
                    
                    // Handle data directives
                    if (directive === 'quad' || directive === 'word' || directive === 'hword' || directive === 'byte') {
                        // Parse comma-separated values
                        const valueStrings = rest.split(',').map(v => v.trim()).filter(v => v);
                        const size = directive === 'quad' ? 8 : directive === 'word' ? 4 : directive === 'hword' ? 2 : 1;
                        
                        for (const valueStr of valueStrings) {
                            try {
                                const value = this.parseValue(valueStr, symbolTable);
                                dataInitializations.push({
                                    address: sectionCounters[currentSection],
                                    value: value,
                                    size: size,
                                    section: currentSection
                                });
                                sectionCounters[currentSection] += BigInt(size);
                            } catch (e) {
                                throw new Error(`Failed to parse value in ${directive} directive: ${valueStr} - ${e.message}`);
                            }
                        }
                    } else if (directive === 'skip') {
                        const size = parseInt(rest);
                        if (!isNaN(size) && size > 0) {
                            // For BSS, track the space (will be zero-initialized)
                            // For other sections, skip just advances the counter
                            if (currentSection === 'bss') {
                                // Track BSS space - it's already zero-initialized, but we need to mark it as used
                                dataInitializations.push({
                                    address: sectionCounters[currentSection],
                                    value: 0n, // Zero value
                                    size: size,
                                    section: currentSection,
                                    isBSS: true // Mark as BSS for tracking
                                });
                            }
                            sectionCounters[currentSection] += BigInt(size);
                        }
                    }
                }
                continue;
            }

            // Instruction (only in .text section)
            if (currentSection === 'text') {
                const parsed = this.simulator.parseInstruction(trimmed);
                if (parsed) {
                    instructions.push({
                        original: trimmed,
                        address: sectionCounters.text,
                        parsed: parsed
                    });
                    sectionCounters.text += 4n;
                }
            }
        }

        return { instructions, dataInitializations };
    }

    parseValue(valueStr, symbolTable) {
        // Remove any whitespace
        valueStr = valueStr.trim();
        
        // Try to parse as immediate (hex)
        if (valueStr.startsWith('0x') || valueStr.startsWith('0X')) {
            return BigInt(valueStr);
        }
        
        // Try to parse as immediate (decimal with #)
        if (valueStr.startsWith('#')) {
            const numStr = valueStr.substring(1).trim();
            if (numStr.startsWith('0x') || numStr.startsWith('0X')) {
                return BigInt(numStr);
            }
            return BigInt(parseInt(numStr, 10));
        }
        
        // Try as decimal number
        const num = parseInt(valueStr, 10);
        if (!isNaN(num)) {
            return BigInt(num);
        }
        
        // Try as label
        if (symbolTable && symbolTable.has(valueStr)) {
            return symbolTable.get(valueStr).address;
        }
        
        throw new Error(`Cannot parse value: ${valueStr}`);
    }

    removeComments(line) {
        // Remove // and ; comments
        const commentIndex = Math.min(
            line.indexOf('//') !== -1 ? line.indexOf('//') : Infinity,
            line.indexOf(';') !== -1 ? line.indexOf(';') : Infinity
        );
        return commentIndex !== Infinity ? line.substring(0, commentIndex) : line;
    }
}

